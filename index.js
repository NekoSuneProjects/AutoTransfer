require("dotenv").config();

const axios = require("axios");
const { Client: HiveClient, PrivateKey } = require("@hiveio/dhive");
const dsteem = require("dsteem");
const dblurt = require("dblurt");

// ---------------- CONFIG ----------------
const ENGINE_API = "https://api.hive-engine.com/rpc/contracts";

const MAIN_LOOP_DELAY = 3 * 60 * 1000; // 3 minutes
const COOLDOWN_MS = 5 * 60 * 1000;
const CUSTOM_JSON_LIMIT = 5;

// ---------------- RESERVES ----------------
const HIVE_RESERVE  = Number(process.env.HIVE_RESERVE  || 0);
const HBD_RESERVE   = Number(process.env.HBD_RESERVE   || 0);
const STEEM_RESERVE = Number(process.env.STEEM_RESERVE || 0);
const SBD_RESERVE   = Number(process.env.SBD_RESERVE   || 0);
const BLURT_RESERVE = Number(process.env.BLURT_RESERVE || 0);

// ---------------- CLIENTS ----------------
const hiveClient  = new HiveClient(process.env.HIVE_RPC);
const steemClient = new dsteem.Client(process.env.STEEM_RPC);
const blurtClient = new dblurt.Client(process.env.BLURT_RPC);

// ---------------- UTILS ----------------
const delay = ms => new Promise(r => setTimeout(r, ms));

function splitList(env) {
  return process.env[env]
    ?.split(",")
    .map(e => e.trim())
    .filter(Boolean) || [];
}

// ---------------- PARSERS ----------------
function parseHiveAccounts() {
  return splitList("HIVE_ACCOUNTS").map(entry => {
    const [name, rest] = entry.split("=");
    const [key, ...modes] = rest.split("|");

    return {
      name,
      key,
      modes: new Set(modes.map(m => m.toLowerCase()))
    };
  });
}

function parseSimpleAccounts(env) {
  return splitList(env).map(entry => {
    const [name, key] = entry.split("=");
    return { name, key };
  });
}

const HIVE_ACCOUNTS  = parseHiveAccounts();
const STEEM_ACCOUNTS = parseSimpleAccounts("STEEM_ACCOUNTS");
const BLURT_ACCOUNTS = parseSimpleAccounts("BLURT_ACCOUNTS");

// ---------------- HIVE ENGINE ----------------
async function getEngineBalances(account) {
  const res = await axios.post(ENGINE_API, {
    jsonrpc: "2.0",
    method: "find",
    params: {
      contract: "tokens",
      table: "balances",
      query: { account },
      limit: 1000
    },
    id: 1
  });
  return res.data.result || [];
}

function buildEngineQueue(tokens, dest) {
  const queue = [];

  for (const t of tokens) {
    const liquid = Number(t.balance);
    const stake = Number(t.stake);
    const pending = Number(t.pendingUnstake);

    if (stake > 0 && pending === 0) {
      queue.push({
        action: "unstake",
        payload: { symbol: t.symbol, quantity: t.stake }
      });
    }

    if (liquid > 0) {
      queue.push({
        action: "transfer",
        payload: {
          symbol: t.symbol,
          to: dest,
          quantity: t.balance,
          memo: ""
        }
      });
    }
  }

  return queue;
}

async function engineBroadcast(account, key, action, payload) {
  return hiveClient.broadcast.json(
    {
      id: "ssc-mainnet-hive",
      required_auths: [account],
      required_posting_auths: [],
      json: JSON.stringify({
        contractName: "tokens",
        contractAction: action,
        contractPayload: payload
      })
    },
    key
  );
}

async function processEngineQueue(account, key, queue) {
  while (queue.length) {
    const slice = queue.splice(0, CUSTOM_JSON_LIMIT);

    for (const job of slice) {
      await engineBroadcast(account, key, job.action, job.payload);
    }

    if (queue.length) await delay(COOLDOWN_MS);
  }
}

// ---------------- BALANCE FETCHERS ----------------
async function getHiveBalances(name) {
  const [acc] = await hiveClient.database.getAccounts([name]);
  return {
    hive: parseFloat(acc.balance),
    hbd: parseFloat(acc.hbd_balance)
  };
}

async function getSteemBalances(name) {
  const [acc] = await steemClient.database.getAccounts([name]);
  return {
    steem: parseFloat(acc.balance),
    sbd: parseFloat(acc.sbd_balance)
  };
}

async function getBlurtBalances(name) {
  const [acc] = await blurtClient.database.getAccounts([name]);
  return {
    blurt: parseFloat(acc.balance)
  };
}

// ---------------- TRANSFER ----------------
async function transfer(client, from, key, to, amount, symbol) {
  return client.broadcast.transfer(
    {
      from,
      to,
      amount: amount.toFixed(3) + " " + symbol,
      memo: ""
    },
    key
  );
}

// ---------------- WORKERS ----------------
async function hiveWorker({ name, key, modes }) {
  const pk = PrivateKey.fromString(key);
  console.log(`?? Hive worker started: ${name}`);

  while (true) {
    try {
      if (modes.has("hive")) {
        const { hive, hbd } = await getHiveBalances(name);

        if (hive > HIVE_RESERVE)
          await transfer(
            hiveClient,
            name,
            pk,
            process.env.DEST_HIVE_NATIVE,
            hive - HIVE_RESERVE,
            "HIVE"
          );

        if (hbd > HBD_RESERVE)
          await transfer(
            hiveClient,
            name,
            pk,
            process.env.DEST_HIVE_NATIVE,
            hbd - HBD_RESERVE,
            "HBD"
          );
      }

      if (modes.has("hivetoken")) {
        const tokens = await getEngineBalances(name);
        const queue = buildEngineQueue(tokens, process.env.DEST_HIVE_TOKENS);
        if (queue.length) await processEngineQueue(name, pk, queue);
      }

    } catch (e) {
      console.error(`HIVE ${name}:`, e.message);
    }

    await delay(MAIN_LOOP_DELAY);
  }
}

async function steemWorker({ name, key }) {
  const pk = dsteem.PrivateKey.fromString(key);
  console.log(`?? Steem worker started: ${name}`);

  while (true) {
    try {
      const { steem, sbd } = await getSteemBalances(name);

      if (steem > STEEM_RESERVE)
        await transfer(
          steemClient,
          name,
          pk,
          process.env.DEST_STEEM,
          steem - STEEM_RESERVE,
          "STEEM"
        );

      if (sbd > SBD_RESERVE)
        await transfer(
          steemClient,
          name,
          pk,
          process.env.DEST_STEEM,
          sbd - SBD_RESERVE,
          "SBD"
        );

    } catch (e) {
      console.error(`STEEM ${name}:`, e.message);
    }

    await delay(MAIN_LOOP_DELAY);
  }
}

async function blurtWorker({ name, key }) {
  const pk = dblurt.PrivateKey.fromString(key);
  console.log(`?? Blurt worker started: ${name}`);

  while (true) {
    try {
      const { blurt } = await getBlurtBalances(name);

      if (blurt > BLURT_RESERVE)
        await transfer(
          blurtClient,
          name,
          pk,
          process.env.DEST_BLURT,
          blurt - BLURT_RESERVE,
          "BLURT"
        );

    } catch (e) {
      console.error(`BLURT ${name}:`, e.message);
    }

    await delay(MAIN_LOOP_DELAY);
  }
}

// ---------------- START ----------------
if (process.env.ENABLE_HIVE === "true")
  HIVE_ACCOUNTS.forEach(hiveWorker);

if (process.env.ENABLE_STEEM === "true")
  STEEM_ACCOUNTS.forEach(steemWorker);

if (process.env.ENABLE_BLURT === "true")
  BLURT_ACCOUNTS.forEach(blurtWorker);
