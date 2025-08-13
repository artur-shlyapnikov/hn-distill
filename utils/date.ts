import { env } from "@config/env";

type Lang = "en" | "ru";

function toLang(): Lang {
  const l = env.SUMMARY_LANG;
  return l === "en" ? "en" : "ru";
}

const pad = (n: number): string => String(n).padStart(2, "0");

export function formatDateHuman(iso: string): string {
  if (!iso || typeof iso !== "string" || iso === "—") {
    return "—";
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }

  const lang = toLang();
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "long",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  };

  try {
    // Use user's local time zone by default for friendlier display
    return new Intl.DateTimeFormat(lang, options).format(d);
  } catch {
    // Fallback: simple YYYY-MM-DD HH:MM
    const y = d.getFullYear();
    const m = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const h = pad(d.getHours());
    const min = pad(d.getMinutes());
    return `${y}-${m}-${day} ${h}:${min}`;
  }
}
