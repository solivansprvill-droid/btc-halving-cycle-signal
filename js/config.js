// 改这里即可。滑块只影响当次浏览，不会改这个文件。
// 减半日按 UTC 日期。estimated: true 的日期在图上标成「预计减半」。
// 之后若要改成固定的 ±400 天，把 windowDays 改成 400，图和表会一起重算。
window.CYCLE_CONFIG = {
  windowDays: 500,
  dayMin: 300,
  dayMax: 700,
  halvings: [
    { date: "2012-11-28", estimated: false },
    { date: "2016-07-09", estimated: false },
    { date: "2020-05-11", estimated: false },
    { date: "2024-04-20", estimated: false },
    { date: "2028-04-17", estimated: true },
  ],
};
