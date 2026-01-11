require("dotenv").config();

const axios = require("axios");
const { Client: HiveClient, PrivateKey } = require("@hiveio/dhive");
const dsteem = require("dsteem");
const dblurt = require("dblurt");

// ---------------- CONFIG ----------------
const ENGINE_API_DEFAULT = "https://api.hive-engine.com/rpc/contracts";

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
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 15000;

function splitListValue(value) {
  return value
    ?.split(",")
    .map(e => e.trim())
    .filter(Boolean) || [];
}

function getEnvList(name, fallback = []) {
  const list = splitListValue(process.env[name]);
  return list.length ? list : fallback;
}

function formatError(err) {
  const status = err?.response?.status;
  const statusText = err?.response?.statusText;
  if (status) return `HTTP ${status}${statusText ? ` ${statusText}` : ""}`;
  return err?.message || String(err);
}

function isRetryableError(err) {
  const status = err?.response?.status;
  if (status && status >= 500) return true;

  const code = err?.code;
  if (code && ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED"].includes(code))
    return true;

  const msg = (err?.message || "").toLowerCase();
  return (
    msg.includes("status code 5") ||
    msg.includes("service unavailable") ||
    msg.includes("socket hang up") ||
    msg.includes("network error")
  );
}

async function retryAsync(fn, label, options = {}) {
  const maxAttempts = options.maxAttempts || RETRY_MAX_ATTEMPTS;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryableError(err) || attempt === maxAttempts) throw err;
      if (options.onRetry) options.onRetry(err, attempt);

      const jitter = Math.floor(Math.random() * 250);
      const delayMs = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1)) + jitter;
      console.warn(`${label} failed (${formatError(err)}). retrying in ${delayMs}ms (${attempt}/${maxAttempts})`);
      await delay(delayMs);
    }
  }
}

const HIVE_RPCS = getEnvList("HIVE_RPC");
const STEEM_RPCS = getEnvList("STEEM_RPC");
const BLURT_RPCS = getEnvList("BLURT_RPC");
const ENGINE_APIS = getEnvList("ENGINE_API", [ENGINE_API_DEFAULT]);

const hiveClient = new HiveClient(HIVE_RPCS.length ? HIVE_RPCS : process.env.HIVE_RPC);
let steemRpcIndex = 0;
let steemClient = new dsteem.Client(STEEM_RPCS[steemRpcIndex] || process.env.STEEM_RPC);
const blurtClient = new dblurt.Client(BLURT_RPCS.length ? BLURT_RPCS : process.env.BLURT_RPC);

function rotateSteemRpc() {
  if (STEEM_RPCS.length <= 1) return;
  steemRpcIndex = (steemRpcIndex + 1) % STEEM_RPCS.length;
  steemClient = new dsteem.Client(STEEM_RPCS[steemRpcIndex]);
}

// ---------------- UTILS ----------------
const delay = ms => new Promise(r => setTimeout(r, ms));

function splitList(env) {
  return splitListValue(process.env[env]);
}

// ---------------- PARSERS ----------------
function parseSimpleAccounts(env) {
  return splitList(env).map(entry => {
    const [name, key] = entry.split("=");
    return { name, key };
  });
}

const HIVE_ACCOUNTS  = parseSimpleAccounts("HIVE_ACCOUNTS");
const HIVE_ENGINE_ACCOUNTS = parseSimpleAccounts("HIVE_ENGINE_ACCOUNTS");
const STEEM_ACCOUNTS = parseSimpleAccounts("STEEM_ACCOUNTS");
const BLURT_ACCOUNTS = parseSimpleAccounts("BLURT_ACCOUNTS");

// ---------------- HIVE ENGINE ----------------
async function getEngineBalances(account) {
  const payload = {
    jsonrpc: "2.0",
    method: "find",
    params: {
      contract: "tokens",
      table: "balances",
      query: { account },
      limit: 1000
    },
    id: 1
  };

  let lastErr;
  for (const url of ENGINE_APIS) {
    try {
      const res = await retryAsync(
        () => axios.post(url, payload),
        `Hive Engine ${url}`
      );
      return res.data.result || [];
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err)) throw err;
    }
  }

  throw lastErr;
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
  const [acc] = await retryAsync(
    () => hiveClient.database.getAccounts([name]),
    `Hive getAccounts ${name}`
  );
  return {
    hive: parseFloat(acc.balance),
    hbd: parseFloat(acc.hbd_balance)
  };
}

async function getSteemBalances(name) {
  const [acc] = await retryAsync(
    () => steemClient.database.getAccounts([name]),
    `Steem getAccounts ${name}`,
    { onRetry: rotateSteemRpc }
  );
  return {
    steem: parseFloat(acc.balance),
    sbd: parseFloat(acc.sbd_balance)
  };
}

async function getBlurtBalances(name) {
  const [acc] = await retryAsync(
    () => blurtClient.database.getAccounts([name]),
    `Blurt getAccounts ${name}`
  );
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
async function hiveWorker({ name, key }) {
  const pk = PrivateKey.fromString(key);
  console.log(`Hive native worker started: ${name}`);

  while (true) {
    try {
      const { hive, hbd } = await getHiveBalances(name);
      const hiveSend = hive - HIVE_RESERVE;
      const hbdSend = hbd - HBD_RESERVE;
      console.log(
        `HIVE ${name} native: balance HIVE=${hive.toFixed(3)} HBD=${hbd.toFixed(3)}; ` +
        `queue HIVE=${Math.max(0, hiveSend).toFixed(3)} HBD=${Math.max(0, hbdSend).toFixed(3)}`
      );

      if (hiveSend > 0)
        await transfer(
          hiveClient,
          name,
          pk,
          process.env.DEST_HIVE_NATIVE,
          hiveSend,
          "HIVE"
        );

      if (hbdSend > 0)
        await transfer(
          hiveClient,
          name,
          pk,
          process.env.DEST_HIVE_NATIVE,
          hbdSend,
          "HBD"
        );
    } catch (e) {
      console.error(`HIVE ${name} native:`, formatError(e));
    }

    await delay(MAIN_LOOP_DELAY);
  }
}

async function hiveEngineWorker({ name, key }) {
  const pk = PrivateKey.fromString(key);
  console.log(`Hive engine worker started: ${name}`);

  while (true) {
    try {
      if (!process.env.DEST_HIVE_TOKENS) {
        console.warn(`HIVE ENGINE ${name} tokens: DEST_HIVE_TOKENS not set`);
      }
      const tokens = await getEngineBalances(name);
      if (!tokens.length) {
        console.log(`HIVE ${name} tokens: no balances found`);
      } else {
        const summary = tokens
          .map(t => {
            const liquid = Number(t.balance || 0);
            const stake = Number(t.stake || 0);
            const pending = Number(t.pendingUnstake || 0);
            return `${t.symbol}=${liquid.toFixed(3)} staked=${stake.toFixed(3)} pending=${pending.toFixed(3)}`;
          })
          .join(" | ");
        console.log(`HIVE ENGINE ${name} tokens: ${summary}`);
      }
      const queue = buildEngineQueue(tokens, process.env.DEST_HIVE_TOKENS);
      console.log(`HIVE ENGINE ${name} tokens: found ${tokens.length} balances, queued ${queue.length} ops`);
      if (queue.length) await processEngineQueue(name, pk, queue);
    } catch (e) {
      console.error(`HIVE ENGINE ${name} tokens:`, formatError(e));
    }

    await delay(MAIN_LOOP_DELAY);
  }
}

async function steemWorker({ name, key }) {
  const pk = dsteem.PrivateKey.fromString(key);
  console.log(`Steem worker started: ${name}`);

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
      console.error(`STEEM ${name}:`, formatError(e));
    }

    await delay(MAIN_LOOP_DELAY);
  }
}

async function blurtWorker({ name, key }) {
  const pk = dblurt.PrivateKey.fromString(key);
  console.log(`Blurt worker started: ${name}`);

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
      console.error(`BLURT ${name}:`, formatError(e));
    }

    await delay(MAIN_LOOP_DELAY);
  }
}

// ---------------- START ----------------
if (process.env.ENABLE_HIVE === "true")
  HIVE_ACCOUNTS.forEach(hiveWorker);

if (process.env.ENABLE_HIVE_ENGINE === "true")
  HIVE_ENGINE_ACCOUNTS.forEach(hiveEngineWorker);

if (process.env.ENABLE_STEEM === "true")
  STEEM_ACCOUNTS.forEach(steemWorker);

if (process.env.ENABLE_BLURT === "true")
  BLURT_ACCOUNTS.forEach(blurtWorker);
