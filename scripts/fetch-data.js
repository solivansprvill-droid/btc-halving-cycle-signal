#!/usr/bin/env node
/**
 * 从 Bitstamp 公开接口分页拉取 BTC/USD 日线，写入 data/data.json。
 * 每次最多 1000 根，把 end 往前移，直到 2011-08-01。
 * GitHub Action 与本地都可以直接运行：node scripts/fetch-data.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const STEP = 86400;
const LIMIT = 1000;
const TARGET = Date.UTC(2011, 7, 1) / 1000;
const OUT = path.join(__dirname, "..", "data", "data.json");
const PAUSE_MS = 280;

function getJson(url) {
  return new Promise((resolve, reject) => {
    execFile(
      "curl",
      ["-fsSL", "--max-time", "45", "-A", "btc-halving-cycle-signal/1.0", url],
      { maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseErr) {
          reject(parseErr);
        }
      }
    );
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getJsonRetry(url) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      return await getJson(url);
    } catch (err) {
      last = err;
      process.stdout.write("  retry " + (i + 1) + " " + err.message + "\n");
      await sleep(700 * (i + 1));
    }
  }
  throw last;
}

function roundPx(n) {
  if (!Number.isFinite(n)) return null;
  if (n >= 100) return Math.round(n * 100) / 100;
  if (n >= 1) return Math.round(n * 100) / 100;
  return Math.round(n * 100000) / 100000;
}

async function fetchAll() {
  let end = Math.floor(Date.now() / 1000) + STEP;
  const map = new Map();
  let guard = 0;

  while (end > TARGET && guard < 40) {
    guard += 1;
    const url =
      "https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=" +
      STEP +
      "&limit=" +
      LIMIT +
      "&end=" +
      end;
    process.stdout.write("GET " + url + "\n");
    const json = await getJsonRetry(url);
    const rows = (json && json.data && json.data.ohlc) || [];
    if (!rows.length) break;

    let oldest = Infinity;
    for (const row of rows) {
      const t = Number(row.timestamp);
      const o = Number(row.open);
      const h = Number(row.high);
      const l = Number(row.low);
      const c = Number(row.close);
      if (!Number.isFinite(t) || !Number.isFinite(c)) continue;
      oldest = Math.min(oldest, t);
      map.set(t, [t, roundPx(o), roundPx(h), roundPx(l), roundPx(c)]);
    }

    process.stdout.write(
      "  rows=" +
        rows.length +
        " oldest=" +
        new Date(oldest * 1000).toISOString().slice(0, 10) +
        " total=" +
        map.size +
        "\n"
    );

    if (oldest <= TARGET) break;
    const nextEnd = oldest - STEP;
    if (!(nextEnd < end)) break;
    end = nextEnd;
    await sleep(PAUSE_MS);
  }

  return [...map.values()]
    .filter((row) => row[0] >= TARGET)
    .sort((a, b) => a[0] - b[0]);
}

async function main() {
  const daily = await fetchAll();
  if (daily.length < 100) {
    throw new Error("日线数量过少: " + daily.length);
  }
  const payload = {
    source: "Bitstamp",
    pair: "BTC/USD",
    step: STEP,
    updatedAt: new Date().toISOString(),
    from: new Date(daily[0][0] * 1000).toISOString().slice(0, 10),
    to: new Date(daily[daily.length - 1][0] * 1000).toISOString().slice(0, 10),
    count: daily.length,
    fields: ["time", "open", "high", "low", "close"],
    daily: daily,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload));
  process.stdout.write(
    "wrote " + OUT + " candles=" + daily.length + " " + payload.from + " → " + payload.to + "\n"
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
