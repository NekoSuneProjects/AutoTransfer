require("dotenv").config();
const axios = require("axios");
const { Client, PrivateKey } = require("@hiveio/dhive");

// ---------------- CONFIG ----------------
const RPC = process.env.HIVE_RPC;
const DEST = process.env.DESTINATION_ACCOUNT;
const ENGINE_API = "https://api.hive-engine.com/rpc/contracts";

const HIVE_RESERVE = Number(process.env.HIVE_RESERVE || 0.001);
const HBD_RESERVE = Number(process.env.HBD_RESERVE || 0.001);

const CUSTOM_JSON_LIMIT = 5;
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const MAIN_LOOP_DELAY = 3 * 60 * 1000; // 3 minutes

const client = new Client(RPC);

// ---------------- PARSE ACCOUNTS ----------------
function parseAccounts() {
  return process.env.HIVE_ACCOUNTS.split(",").map(entry => {
    const [name, key] = entry.split("=");
    return {
      name,
      key: PrivateKey.fromString(key)
    };
  });
}

const ACCOUNTS = parseAccounts();

// ---------------- ENGINE BALANCES ----------------
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

// ---------------- ENGINE BROADCAST ----------------
async function engineBroadcast(account, key, action, payload) {
  return client.broadcast.json(
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

// ---------------- HIVE BALANCES ----------------
async function getHiveBalances(account) {
  const [acc] = await client.database.getAccounts([account]);
  return {
    hive: parseFloat(acc.balance),
    hbd: parseFloat(acc.hbd_balance)
  };
}

// ---------------- HIVE TRANSFER ----------------
async function transferHive(account, key, amount, symbol) {
  return client.broadcast.transfer(
    {
      from: account,
      to: DEST,
      amount: amount.toFixed(3) + " " + symbol,
      memo: ""
    },
    key
  );
}

// ---------------- BUILD ENGINE QUEUE ----------------
function buildEngineQueue(tokens) {
  const queue = [];

  for (const t of tokens) {
    const liquid = Number(t.balance);
    const stake = Number(t.stake);
    const pending = Number(t.pendingUnstake);

    if (stake > 0 && pending === 0) {
      queue.push({
        action: "unstake",
        payload: {
          symbol: t.symbol,
          quantity: t.stake
        }
      });
    }

    if (liquid > 0) {
      queue.push({
        action: "transfer",
        payload: {
          symbol: t.symbol,
          to: DEST,
          quantity: t.balance,
          memo: ""
        }
      });
    }
  }

  return queue;
}

// ---------------- PROCESS ENGINE QUEUE (PER ACCOUNT) ----------------
async function processEngineQueue(account, key, queue) {
  let batch = 0;

  while (queue.length > 0) {
    batch++;
    const slice = queue.splice(0, CUSTOM_JSON_LIMIT);

    console.log(
      `${account}: Engine batch ${batch} (${slice.length} ops)`
    );

    for (const job of slice) {
      await engineBroadcast(account, key, job.action, job.payload);
    }

    if (queue.length > 0) {
      console.log(
        `${account}: Cooldown ${COOLDOWN_MS / 60000} minutes`
      );
      await new Promise(r => setTimeout(r, COOLDOWN_MS));
    }
  }
}

// ---------------- ACCOUNT WORKER ----------------
async function accountWorker({ name, key }) {
  console.log(`🟢 Worker started for ${name}`);

  while (true) {
    try {
      console.log(`\n▶ Processing ${name}`);

      // ----- HIVE / HBD -----
      const { hive, hbd } = await getHiveBalances(name);

      if (hive > HIVE_RESERVE) {
        const send = hive - HIVE_RESERVE;
        console.log(`${name}: Sending ${send.toFixed(3)} HIVE`);
        await transferHive(name, key, send, "HIVE");
      }

      if (hbd > HBD_RESERVE) {
        const send = hbd - HBD_RESERVE;
        console.log(`${name}: Sending ${send.toFixed(3)} HBD`);
        await transferHive(name, key, send, "HBD");
      }

      // ----- HIVE-ENGINE -----
      const tokens = await getEngineBalances(name);
      const queue = buildEngineQueue(tokens);

      if (queue.length > 0) {
        await processEngineQueue(name, key, queue);
      }

      console.log(`✓ ${name} cycle complete`);
    } catch (e) {
      console.error(`❌ ${name} error:`, e.message);
    }

    // independent loop delay per account
    await new Promise(r => setTimeout(r, MAIN_LOOP_DELAY));
  }
}

// ---------------- START ALL WORKERS ----------------
function start() {
  ACCOUNTS.forEach(acc => {
    accountWorker(acc); // fire-and-forget
  });
}

start();
