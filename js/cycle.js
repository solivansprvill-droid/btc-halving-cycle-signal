/**
 * 减半周期的纯计算。浏览器和 Node 都能用，方便核对回测价格。
 * 周K从周一 00:00 UTC 起。信号价取信号日所在周的收盘；该周没有数据时，才退回 10 天内最近的周收盘。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Cycle = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var WEEK = 7 * 86400;
  var PRICE_MAX_GAP_DAYS = 10;

  function parseDate(iso) {
    var parts = String(iso).split("-").map(Number);
    return Date.UTC(parts[0], parts[1] - 1, parts[2]) / 1000;
  }

  function formatDate(ts) {
    return new Date(ts * 1000).toISOString().slice(0, 10);
  }

  function weekStart(ts) {
    var d = new Date(ts * 1000);
    var sinceMonday = (d.getUTCDay() + 6) % 7;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday) / 1000;
  }

  function aggregateWeeks(daily) {
    var buckets = new Map();
    for (var i = 0; i < daily.length; i++) {
      var row = daily[i];
      var t = Number(row[0]);
      var o = Number(row[1]);
      var h = Number(row[2]);
      var l = Number(row[3]);
      var c = Number(row[4]);
      if (!Number.isFinite(t) || !Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) {
        continue;
      }
      var ws = weekStart(t);
      var bar = buckets.get(ws);
      if (!bar) {
        buckets.set(ws, {
          time: ws,
          open: o,
          high: h,
          low: l,
          close: c,
          closeTime: t,
          firstTime: t,
          days: 1,
        });
        continue;
      }
      if (t < bar.firstTime) {
        bar.open = o;
        bar.firstTime = t;
      }
      if (h > bar.high) bar.high = h;
      if (l < bar.low) bar.low = l;
      if (t >= bar.closeTime) {
        bar.close = c;
        bar.closeTime = t;
      }
      bar.days += 1;
    }
    return Array.from(buckets.values()).sort(function (a, b) {
      return a.time - b.time;
    });
  }

  function buildSlots(weeks, untilTs) {
    if (!weeks.length) return [];
    var start = weeks[0].time;
    var end = Math.max(weeks[weeks.length - 1].time, weekStart(untilTs));
    var byTime = new Map();
    for (var i = 0; i < weeks.length; i++) byTime.set(weeks[i].time, weeks[i]);
    var slots = [];
    for (var t = start; t <= end + 1; t += WEEK) {
      var candle = byTime.get(t) || null;
      slots.push({ time: t, candle: candle });
    }
    return slots;
  }

  function sma(weeks, period) {
    var out = [];
    var sum = 0;
    for (var i = 0; i < weeks.length; i++) {
      sum += weeks[i].close;
      if (i >= period) sum -= weeks[i - period].close;
      if (i >= period - 1) {
        out.push({ time: weeks[i].time, value: sum / period });
      }
    }
    return out;
  }

  function nearestWeek(weeks, ts) {
    var best = null;
    var bestAbs = Infinity;
    for (var i = 0; i < weeks.length; i++) {
      var dist = Math.abs(weeks[i].closeTime - ts);
      if (dist < bestAbs) {
        bestAbs = dist;
        best = weeks[i];
      }
    }
    if (!best) return null;
    return { week: best, distanceDays: bestAbs / 86400 };
  }

  function weekAt(weeks, ts) {
    var start = weekStart(ts);
    for (var i = 0; i < weeks.length; i++) {
      if (weeks[i].time === start) return weeks[i];
    }
    return null;
  }

  function priceForSignal(weeks, ts, lastCloseTime) {
    if (!weeks.length || ts > lastCloseTime + 12 * 3600) return null;
    var contained = weekAt(weeks, ts);
    if (contained) {
      return { week: contained, distanceDays: Math.abs(contained.closeTime - ts) / 86400 };
    }
    var hit = nearestWeek(weeks, ts);
    if (!hit || hit.distanceDays > PRICE_MAX_GAP_DAYS) return null;
    return hit;
  }

  function buildCycles(halvings, windowDays, weeks) {
    var lastClose = weeks.length ? weeks[weeks.length - 1].closeTime : 0;
    return halvings.map(function (item, index) {
      var halvingTs = parseDate(item.date);
      var buyTs = halvingTs - windowDays * 86400;
      var sellTs = halvingTs + windowDays * 86400;
      var buyHit = priceForSignal(weeks, buyTs, lastClose);
      var sellHit = priceForSignal(weeks, sellTs, lastClose);
      var buyPrice = buyHit ? buyHit.week.close : null;
      var sellPrice = sellHit ? sellHit.week.close : null;
      var status = "upcoming";
      if (buyPrice != null && sellPrice != null) status = "complete";
      else if (buyPrice != null) status = "open";
      else if (buyTs <= lastClose + 12 * 3600) status = "insufficient";
      var multiple = buyPrice && sellPrice ? sellPrice / buyPrice : null;
      return {
        index: index + 1,
        estimated: !!item.estimated,
        halvingDate: item.date,
        halvingTs: halvingTs,
        buyTs: buyTs,
        sellTs: sellTs,
        buyDate: formatDate(buyTs),
        sellDate: formatDate(sellTs),
        buyPrice: buyPrice,
        sellPrice: sellPrice,
        buyWeek: buyHit ? buyHit.week : null,
        sellWeek: sellHit ? sellHit.week : null,
        status: status,
        multiple: multiple,
        pct: multiple == null ? null : (multiple - 1) * 100,
      };
    });
  }

  function focusCycle(cycles, todayIso) {
    var today = parseDate(todayIso);
    for (var i = cycles.length - 1; i >= 0; i--) {
      if (cycles[i].buyTs <= today && today <= cycles[i].sellTs) return cycles[i];
    }
    for (var j = 0; j < cycles.length; j++) {
      if (cycles[j].buyTs > today) return cycles[j];
    }
    return cycles.length ? cycles[cycles.length - 1] : null;
  }

  function returnsDecreasing(cycles) {
    var done = cycles.filter(function (c) {
      return c.status === "complete" && c.pct != null;
    });
    if (done.length < 2) return false;
    for (var i = 1; i < done.length; i++) {
      if (!(done[i].pct < done[i - 1].pct)) return false;
    }
    return true;
  }

  function shanghaiToday(now) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now || new Date());
  }

  function daysBetween(fromIso, toIso) {
    var a = Date.parse(fromIso + "T00:00:00Z");
    var b = Date.parse(toIso + "T00:00:00Z");
    return Math.round((b - a) / 86400000);
  }

  return {
    WEEK: WEEK,
    parseDate: parseDate,
    formatDate: formatDate,
    weekStart: weekStart,
    aggregateWeeks: aggregateWeeks,
    buildSlots: buildSlots,
    sma: sma,
    buildCycles: buildCycles,
    focusCycle: focusCycle,
    returnsDecreasing: returnsDecreasing,
    shanghaiToday: shanghaiToday,
    daysBetween: daysBetween,
  };
});
