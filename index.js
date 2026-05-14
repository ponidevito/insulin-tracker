require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Telegraf, Markup } = require("telegraf");
const admin = require("firebase-admin");

const FIREBASE_KEY_PATH = path.join(__dirname, "firebase-key.json");
const MIN_INJECTION_INTERVAL_MINUTES = 30;
const TIME_ZONE = "Europe/Kyiv";

const BUTTONS = {
  ADD_INJECTION: "➕ Вколов",
  TODAY: "📅 Сьогодні",
  STATS: "📊 Статистика",
  LAST_INJECTION: "🕒 Останній укол",
  CANCEL_LAST: "↩️ Скасувати останній",
};

const INSULIN_TYPES = {
  rapid: "Швидкий",
  long: "Довгий",
  other: "Інший",
};

const pendingInjections = new Map();

function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

      if (serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
      }

      return serviceAccount;
    } catch (error) {
      console.error("FIREBASE_SERVICE_ACCOUNT must be valid JSON.");
      process.exit(1);
    }
  }

  if (!fs.existsSync(FIREBASE_KEY_PATH)) {
    console.error(
      "Firebase credentials are missing. Add FIREBASE_SERVICE_ACCOUNT env variable or firebase-key.json file."
    );
    process.exit(1);
  }

  return require(FIREBASE_KEY_PATH);
}

if (!process.env.BOT_TOKEN) {
  console.error("BOT_TOKEN is missing. Add it to your .env file.");
  process.exit(1);
}

const serviceAccount = loadServiceAccount();

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const bot = new Telegraf(process.env.BOT_TOKEN);

const timeFormatter = new Intl.DateTimeFormat("uk-UA", {
  timeZone: TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
});

const dateFormatter = new Intl.DateTimeFormat("uk-UA", {
  timeZone: TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const dayPartsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const dateTimePartsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function mainKeyboard() {
  return Markup.keyboard([
    [BUTTONS.ADD_INJECTION],
    [BUTTONS.TODAY, BUTTONS.STATS],
    [BUTTONS.LAST_INJECTION, BUTTONS.CANCEL_LAST],
  ]).resize();
}

function insulinTypeKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(INSULIN_TYPES.rapid, "insulin_type:rapid"),
      Markup.button.callback(INSULIN_TYPES.long, "insulin_type:long"),
    ],
    [Markup.button.callback(INSULIN_TYPES.other, "insulin_type:other")],
  ]);
}

function partsToObject(parts) {
  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
}

function getTimeZoneOffsetMs(timeZone, date) {
  const parts = partsToObject(dateTimePartsFormatter.formatToParts(date));
  const zonedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );

  return zonedAsUtc - date.getTime();
}

function zonedTimeToUtc(year, month, day, hour = 0, minute = 0, second = 0) {
  const utcTime = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstOffset = getTimeZoneOffsetMs(TIME_ZONE, new Date(utcTime));
  const firstUtcDate = new Date(utcTime - firstOffset);
  const secondOffset = getTimeZoneOffsetMs(TIME_ZONE, firstUtcDate);

  return new Date(utcTime - secondOffset);
}

function getTodayRange() {
  const todayParts = partsToObject(dayPartsFormatter.formatToParts(new Date()));
  const start = zonedTimeToUtc(todayParts.year, todayParts.month, todayParts.day);
  const end = zonedTimeToUtc(todayParts.year, todayParts.month, todayParts.day + 1);

  return {
    start,
    end,
  };
}

function getUserInjectionsQuery(userId) {
  return db
    .collection("injections")
    .where("userId", "==", userId)
    .orderBy("createdAt", "desc");
}

async function getLastInjection(userId) {
  const snapshot = await getUserInjectionsQuery(userId).limit(1).get();

  if (snapshot.empty) {
    return null;
  }

  const doc = snapshot.docs[0];

  return {
    id: doc.id,
    ref: doc.ref,
    ...doc.data(),
  };
}

async function getTodayInjections(userId) {
  const { start, end } = getTodayRange();
  const snapshot = await db
    .collection("injections")
    .where("userId", "==", userId)
    .where("createdAtMs", ">=", start.getTime())
    .where("createdAtMs", "<", end.getTime())
    .orderBy("createdAtMs", "asc")
    .get();

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ref: doc.ref,
    ...doc.data(),
  }));
}

async function addInjection(userId, details) {
  const createdAt = admin.firestore.Timestamp.now();

  await db.collection("injections").add({
    userId,
    units: details.units,
    insulinType: details.insulinType,
    insulinTypeLabel: INSULIN_TYPES[details.insulinType],
    createdAt,
    createdAtMs: createdAt.toMillis(),
  });

  return createdAt.toDate();
}

async function deleteLastInjection(userId) {
  const lastInjection = await getLastInjection(userId);

  if (!lastInjection) {
    return null;
  }

  await lastInjection.ref.delete();

  return lastInjection;
}

function getMinutesAgo(date) {
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000 / 60));
}

function formatTimeAgo(minutes) {
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours} год ${minutes % 60} хв тому`;
  }

  return `${minutes} хв тому`;
}

function parseUnits(text) {
  const normalizedText = text.replace(",", ".").trim();
  const units = Number(normalizedText);

  if (!Number.isFinite(units) || units <= 0 || units > 100) {
    return null;
  }

  return Math.round(units * 10) / 10;
}

function formatInjectionDetails(injection) {
  const details = [];

  if (injection.units) {
    details.push(`💉 Доза: ${injection.units} од.`);
  }

  if (injection.insulinTypeLabel) {
    details.push(`🏷️ Тип: ${injection.insulinTypeLabel}`);
  }

  return details.length ? `\n${details.join("\n")}` : "";
}

function formatTodayInjections(injections) {
  const totalUnits = injections.reduce((sum, injection) => sum + (Number(injection.units) || 0), 0);
  const lines = injections.map((injection, index) => {
    const createdAtDate = injection.createdAt.toDate();
    const units = injection.units ? `${injection.units} од.` : "доза не вказана";
    const type = injection.insulinTypeLabel || "тип не вказано";

    return `${index + 1}. ${timeFormatter.format(createdAtDate)} — ${units}, ${type}`;
  });

  return [
    `📅 Сьогодні: ${dateFormatter.format(new Date())}`,
    "",
    ...lines,
    "",
    `Уколів: ${injections.length}`,
    `Усього: ${Math.round(totalUnits * 10) / 10} од.`,
  ].join("\n");
}

function formatTodayStats(injections) {
  const stats = injections.reduce(
    (result, injection) => {
      const type = injection.insulinType || "unknown";
      const label = injection.insulinTypeLabel || "Тип не вказано";
      const units = Number(injection.units) || 0;

      if (!result.byType[type]) {
        result.byType[type] = {
          label,
          count: 0,
          units: 0,
        };
      }

      result.totalCount += 1;
      result.totalUnits += units;
      result.byType[type].count += 1;
      result.byType[type].units += units;

      return result;
    },
    {
      totalCount: 0,
      totalUnits: 0,
      byType: {},
    }
  );

  const typeLines = Object.values(stats.byType).map((typeStats) => {
    const units = Math.round(typeStats.units * 10) / 10;

    return `${typeStats.label}: ${typeStats.count} укол(и), ${units} од.`;
  });

  return [
    `📊 Статистика за сьогодні: ${dateFormatter.format(new Date())}`,
    "",
    `Усього уколів: ${stats.totalCount}`,
    `Усього одиниць: ${Math.round(stats.totalUnits * 10) / 10} од.`,
    "",
    ...typeLines,
  ].join("\n");
}

function clearPendingInjection(userId) {
  pendingInjections.delete(userId);
}

function logError(message, error) {
  console.error(message, error && error.message ? error.message : error);
}

bot.start((ctx) => {
  clearPendingInjection(ctx.from.id);

  ctx.reply(
    "👋 Привіт!\n\nЯ допоможу памʼятати останній укол інсуліну.",
    mainKeyboard()
  );
});

bot.hears(BUTTONS.ADD_INJECTION, async (ctx) => {
  try {
    const userId = ctx.from.id;
    const lastInjection = await getLastInjection(userId);

    if (lastInjection) {
      const lastInjectionDate = lastInjection.createdAt.toDate();
      const minutes = getMinutesAgo(lastInjectionDate);

      if (minutes < MIN_INJECTION_INTERVAL_MINUTES) {
        return ctx.reply(
          `⚠️ Увага!\n\nОстанній укол був лише ${minutes} хв тому.`
        );
      }
    }

    pendingInjections.set(userId, { step: "waiting_units" });

    ctx.reply("💉 Скільки одиниць інсуліну ти вколов? Наприклад: 4 або 4.5");
  } catch (error) {
    logError("Failed to start injection flow:", error);
    ctx.reply("❌ Помилка при підготовці запису.");
  }
});

bot.hears(BUTTONS.TODAY, async (ctx) => {
  try {
    const userId = ctx.from.id;
    clearPendingInjection(userId);

    const injections = await getTodayInjections(userId);

    if (!injections.length) {
      return ctx.reply("📅 За сьогодні ще немає записів.", mainKeyboard());
    }

    ctx.reply(formatTodayInjections(injections), mainKeyboard());
  } catch (error) {
    logError("Failed to get today injections:", error);
    ctx.reply("❌ Помилка при отриманні записів за сьогодні.");
  }
});

bot.hears(BUTTONS.STATS, async (ctx) => {
  try {
    const userId = ctx.from.id;
    clearPendingInjection(userId);

    const injections = await getTodayInjections(userId);

    if (!injections.length) {
      return ctx.reply("📊 За сьогодні ще немає даних для статистики.", mainKeyboard());
    }

    ctx.reply(formatTodayStats(injections), mainKeyboard());
  } catch (error) {
    logError("Failed to get today stats:", error);
    ctx.reply("❌ Помилка при отриманні статистики.");
  }
});

bot.hears(BUTTONS.LAST_INJECTION, async (ctx) => {
  try {
    const userId = ctx.from.id;
    clearPendingInjection(userId);

    const lastInjection = await getLastInjection(userId);

    if (!lastInjection) {
      return ctx.reply("❌ У тебе ще немає записів.");
    }

    const lastInjectionDate = lastInjection.createdAt.toDate();
    const minutes = getMinutesAgo(lastInjectionDate);
    const details = formatInjectionDetails(lastInjection);

    ctx.reply(
      `🩸 Останній укол:${details}\n\n🕒 ${timeFormatter.format(lastInjectionDate)}\n📅 ${dateFormatter.format(lastInjectionDate)}\n\n⏳ ${formatTimeAgo(minutes)}`
    );
  } catch (error) {
    logError("Failed to get last injection:", error);
    ctx.reply("❌ Помилка при отриманні даних.");
  }
});

bot.hears(BUTTONS.CANCEL_LAST, async (ctx) => {
  try {
    const userId = ctx.from.id;
    clearPendingInjection(userId);

    const deletedInjection = await deleteLastInjection(userId);

    if (!deletedInjection) {
      return ctx.reply("❌ Немає запису, який можна скасувати.");
    }

    const deletedAtDate = deletedInjection.createdAt.toDate();
    const details = formatInjectionDetails(deletedInjection);

    ctx.reply(
      `↩️ Останній запис скасовано${details}\n\n🕒 ${timeFormatter.format(deletedAtDate)}\n📅 ${dateFormatter.format(deletedAtDate)}`,
      mainKeyboard()
    );
  } catch (error) {
    logError("Failed to cancel last injection:", error);
    ctx.reply("❌ Помилка при скасуванні запису.");
  }
});

bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const pendingInjection = pendingInjections.get(userId);

  if (!pendingInjection || pendingInjection.step !== "waiting_units") {
    return;
  }

  const units = parseUnits(ctx.message.text);

  if (!units) {
    return ctx.reply("Введи дозу числом від 0.1 до 100. Наприклад: 6 або 6.5");
  }

  pendingInjections.set(userId, {
    step: "waiting_type",
    units,
  });

  ctx.reply("🏷️ Обери тип інсуліну:", insulinTypeKeyboard());
});

bot.action(/^insulin_type:(rapid|long|other)$/, async (ctx) => {
  const userId = ctx.from.id;
  const insulinType = ctx.match[1];
  const pendingInjection = pendingInjections.get(userId);

  if (!pendingInjection || pendingInjection.step !== "waiting_type") {
    await ctx.answerCbQuery();
    return ctx.reply("Запис не знайдено. Натисни “Вколов”, щоб почати заново.");
  }

  try {
    const createdAtDate = await addInjection(userId, {
      units: pendingInjection.units,
      insulinType,
    });

    clearPendingInjection(userId);
    await ctx.answerCbQuery("Записано");

    ctx.reply(
      `✅ Інсулін записано\n\n💉 Доза: ${pendingInjection.units} од.\n🏷️ Тип: ${INSULIN_TYPES[insulinType]}\n🕒 ${timeFormatter.format(createdAtDate)}`,
      mainKeyboard()
    );
  } catch (error) {
    logError("Failed to add injection:", error);
    await ctx.answerCbQuery();
    ctx.reply("❌ Помилка при записі.");
  }
});

bot.launch();

console.log("✅ Bot started");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
