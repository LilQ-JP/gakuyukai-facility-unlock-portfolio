const japanDateTimeFormatter = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  hourCycle: "h23",
  timeZone: "Asia/Tokyo"
});

export function parseJapanDateTimeLocal(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw = "00"] = match;
  const expected = {
    year: Number(yearRaw),
    month: Number(monthRaw),
    day: Number(dayRaw),
    hour: Number(hourRaw),
    minute: Number(minuteRaw),
    second: Number(secondRaw)
  };
  const date = new Date(Date.UTC(
    expected.year,
    expected.month - 1,
    expected.day,
    expected.hour - 9,
    expected.minute,
    expected.second
  ));
  const actual = Object.fromEntries(
    japanDateTimeFormatter.formatToParts(date)
      .filter((part) => expected[part.type] !== undefined)
      .map((part) => [part.type, Number(part.value)])
  );
  return Object.entries(expected).every(([key, number]) => actual[key] === number) ? date : null;
}
