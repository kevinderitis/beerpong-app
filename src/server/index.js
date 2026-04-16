import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import dotenv from "dotenv";
import express from "express";
import jwt from "jsonwebtoken";
import { MongoClient, ObjectId } from "mongodb";
import { Server } from "socket.io";
import webpush from "web-push";

dotenv.config();
dayjs.extend(utc);
dayjs.extend(timezone);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");
const clientDistDir = path.join(rootDir, "dist/client");

const PORT = Number(process.env.PORT || 3001);
const JWT_SECRET = process.env.JWT_SECRET || "beerpong-secret";
const APP_TIMEZONE =
  process.env.APP_TIMEZONE || "America/Argentina/Buenos_Aires";
const DRAW_REVEAL_INTERVAL_MS = Number(
  process.env.DRAW_REVEAL_INTERVAL_MS || 3000,
);
const DRAW_COUNTDOWN_SECONDS = Number(
  process.env.DRAW_COUNTDOWN_SECONDS || 15,
);
const MONGODB_URI = process.env.MONGODB_URI || "";
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "beerpong_app";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const WEB_PUSH_ENABLED = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

const ADMIN_USER = {
  username: process.env.ADMIN_USERNAME || "AdminArenaBeerPong8768",
  password: process.env.ADMIN_PASSWORD || "admin8768",
  role: "admin",
  isPrimary: true,
};

if (!MONGODB_URI) {
  throw new Error("Missing MONGODB_URI in environment variables.");
}

if (WEB_PUSH_ENABLED) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

const mongoClient = new MongoClient(MONGODB_URI);
let database;
let collections;

const revealTimers = new Map();

const now = () => dayjs().tz(APP_TIMEZONE);

const serialize = (document) => {
  if (!document) {
    return null;
  }

  const serialized = { ...document, id: String(document._id) };
  delete serialized._id;
  return serialized;
};

const getObjectId = (value) => {
  if (!ObjectId.isValid(value)) {
    return null;
  }

  return new ObjectId(value);
};

const normalizeName = (value) =>
  value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .replaceAll(/\s+/g, " ");

const shuffle = (items) => {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
};

const demoPlayers = [
  "Alex", "Bruno", "Camila", "Dario", "Emma",
  "Facu", "Gina", "Hector", "Ines", "Juli",
  "Kevin", "Lola", "Mateo", "Nora", "Otto",
  "Paula", "Quino", "Rocio", "Santi", "Tomas",
];

const getDateMeta = (reference = now()) => ({
  dateKey: reference.format("YYYY-MM-DD"),
  opensAt: reference.hour(8).minute(0).second(0).millisecond(0),
  closesAt: reference.hour(21).minute(30).second(0).millisecond(0),
});

const buildTournamentKey = (reference = now()) =>
  `${reference.format("YYYY-MM-DD")}__${reference.valueOf()}`;

const ensureIndexes = async () => {
  await Promise.all([
    collections.tournaments.createIndex({ date_key: 1, created_at: -1 }),
    collections.tournaments.createIndex({ status: 1, created_at: -1 }),
    collections.registrations.createIndex(
      { tournament_id: 1, normalized_name: 1 },
      { unique: true },
    ),
    collections.registrations.createIndex({ tournament_id: 1, created_at: 1 }),
    collections.teams.createIndex({ tournament_id: 1, slot: 1 }, { unique: true }),
    collections.teamMembers.createIndex({ team_id: 1 }),
    collections.matches.createIndex({ tournament_id: 1, table_number: 1, queue_index: 1 }),
    collections.drawProgress.createIndex({ tournament_id: 1 }, { unique: true }),
    collections.staffUsers.createIndex({ normalized_name: 1 }, { unique: true }),
    collections.staffUsers.createIndex({ username: 1 }, { unique: true }),
    collections.pushSubscriptions.createIndex({ endpoint: 1 }, { unique: true }),
  ]);
};

const getTournamentById = async (tournamentId) => {
  const objectId = getObjectId(tournamentId);
  if (!objectId) {
    return null;
  }

  return serialize(await collections.tournaments.findOne({ _id: objectId }));
};

const getLatestTournamentForDay = async (dateKey) =>
  serialize(
    await collections.tournaments.findOne(
      { date_key: { $regex: `^${dateKey}` } },
      { sort: { created_at: -1 } },
    ),
  );

const setTournamentLifecycle = async (
  tournamentId,
  {
    status,
    registrationOpensAt,
    registrationClosesAt,
    drawBeginsAt,
    drawStartedAt,
    drawCompletedAt,
  },
) => {
  const current = await getTournamentById(tournamentId);

  await collections.tournaments.updateOne(
    { _id: getObjectId(tournamentId) },
    {
      $set: {
        status: status ?? current.status,
        registration_opens_at:
          registrationOpensAt ?? current.registration_opens_at,
        registration_closes_at:
          registrationClosesAt ?? current.registration_closes_at,
        draw_begins_at:
          drawBeginsAt === undefined ? current.draw_begins_at : drawBeginsAt,
        draw_started_at:
          drawStartedAt === undefined ? current.draw_started_at : drawStartedAt,
        draw_completed_at:
          drawCompletedAt === undefined
            ? current.draw_completed_at
            : drawCompletedAt,
        updated_at: now().toISOString(),
      },
    },
  );

  return getTournamentById(tournamentId);
};

const createTournamentRecord = async (
  status = "registration_closed",
  reference = now(),
) => {
  const { opensAt, closesAt } = getDateMeta(reference);
  const createdAt = reference.toISOString();
  const document = {
    date_key: buildTournamentKey(reference),
    status,
    registration_opens_at: opensAt.toISOString(),
    registration_closes_at: closesAt.toISOString(),
    draw_begins_at: null,
    draw_started_at: null,
    draw_completed_at: null,
    created_at: createdAt,
    updated_at: createdAt,
  };

  const result = await collections.tournaments.insertOne(document);
  await collections.drawProgress.updateOne(
    { tournament_id: String(result.insertedId) },
    { $set: { tournament_id: String(result.insertedId), reveal_count: 0 } },
    { upsert: true },
  );

  return getTournamentById(String(result.insertedId));
};

const ensureTournamentForToday = async (reference = now()) => {
  const { dateKey } = getDateMeta(reference);
  let tournament = await getLatestTournamentForDay(dateKey);

  if (!tournament) {
    tournament = await createTournamentRecord("registration_closed", reference);
  }

  return tournament;
};

const listRegistrationsByTournament = async (tournamentId) =>
  (await collections.registrations.find({ tournament_id: tournamentId }).sort({ created_at: 1 }).toArray()).map(serialize);

const buildTeams = async (tournamentId) => {
  const teams = (await collections.teams.find({ tournament_id: tournamentId }).sort({ slot: 1 }).toArray()).map(serialize);
  const members = (await collections.teamMembers.find({ tournament_id: tournamentId }).sort({ created_at: 1 }).toArray()).map(serialize);
  const memberMap = new Map();

  for (const member of members) {
    const list = memberMap.get(member.team_id) || [];
    list.push(member.player_name);
    memberMap.set(member.team_id, list);
  }

  return teams.map((team) => ({
    ...team,
    members: memberMap.get(team.id) || [],
  }));
};

const buildMatches = async (tournamentId, teams) => {
  const teamMap = new Map(teams.map((team) => [team.id, team]));
  const matches = (await collections.matches.find({ tournament_id: tournamentId }).sort({
    table_number: 1,
    queue_index: 1,
  }).toArray()).map(serialize);

  return matches.map((match) => ({
    ...match,
    teamA: teamMap.get(match.team_a_id) || null,
    teamB: teamMap.get(match.team_b_id) || null,
    winner: teamMap.get(match.winner_team_id) || null,
  }));
};

const createDrawForTournament = async (tournamentId) => {
  const registrations = (await listRegistrationsByTournament(tournamentId)).filter(
    (registration) => registration.paid,
  );

  await Promise.all([
    collections.matches.deleteMany({ tournament_id: tournamentId }),
    collections.teamMembers.deleteMany({ tournament_id: tournamentId }),
    collections.teams.deleteMany({ tournament_id: tournamentId }),
    collections.drawProgress.updateOne(
      { tournament_id: tournamentId },
      { $set: { tournament_id: tournamentId, reveal_count: 0 } },
      { upsert: true },
    ),
  ]);

  const shuffled = shuffle(registrations);
  const teamIds = [];

  for (let index = 0; index + 1 < shuffled.length; index += 2) {
    const slot = teamIds.length + 1;
    const createdAt = now().toISOString();
    const rewardLabel = [1, 5, 9].includes(slot) ? "Roulette Spin" : null;
    const teamResult = await collections.teams.insertOne({
      tournament_id: tournamentId,
      slot,
      name: `Team ${slot}`,
      reward_label: rewardLabel,
      created_at: createdAt,
    });

    const teamId = String(teamResult.insertedId);
    teamIds.push(teamId);

    await collections.teamMembers.insertMany([
      {
        tournament_id: tournamentId,
        team_id: teamId,
        registration_id: shuffled[index].id,
        player_name: shuffled[index].name,
        created_at: createdAt,
      },
      {
        tournament_id: tournamentId,
        team_id: teamId,
        registration_id: shuffled[index + 1].id,
        player_name: shuffled[index + 1].name,
        created_at: createdAt,
      },
    ]);
  }

  const queue = { 1: 1, 2: 1 };
  for (let index = 0; index + 1 < teamIds.length; index += 2) {
    const tableNumber = (index / 2) % 2 === 0 ? 1 : 2;
    const queueIndex = queue[tableNumber];
    queue[tableNumber] += 1;

    await collections.matches.insertOne({
      tournament_id: tournamentId,
      table_number: tableNumber,
      queue_index: queueIndex,
      team_a_id: teamIds[index],
      team_b_id: teamIds[index + 1],
      status: "queued",
      winner_team_id: null,
      completed_at: null,
      created_at: now().toISOString(),
    });
  }

  return setTournamentLifecycle(tournamentId, {
    status: "draw_revealing",
    drawStartedAt: now().toISOString(),
  });
};

const finalizeTournament = async (tournamentId) => {
  stopRevealTimer(tournamentId);

  return setTournamentLifecycle(tournamentId, {
    status: "completed",
    drawBeginsAt: null,
    drawCompletedAt: now().toISOString(),
  });
};

const getPendingWinnersForTable = (matches, tableNumber) => {
  const tableMatches = matches
    .filter((match) => match.table_number === tableNumber)
    .sort((left, right) => left.queue_index - right.queue_index);

  return tableMatches
    .filter((match) => match.status === "completed" && match.winner_team_id)
    .filter(
      (match) =>
        !tableMatches.some(
          (candidate) =>
            candidate.queue_index > match.queue_index &&
            [candidate.team_a_id, candidate.team_b_id].includes(match.winner_team_id),
        ),
    )
    .map((match) => ({
      sourceMatchId: match.id,
      teamId: match.winner_team_id,
      queueIndex: match.queue_index,
    }));
};

const getTableChampionTeamId = (matches, tableNumber) => {
  const tableMatches = matches.filter((match) => match.table_number === tableNumber);

  if (!tableMatches.length) {
    return null;
  }

  if (tableMatches.some((match) => ["queued", "live"].includes(match.status))) {
    return null;
  }

  const pendingWinners = getPendingWinnersForTable(matches, tableNumber);
  return pendingWinners.length === 1 ? pendingWinners[0].teamId : null;
};

const maybeQueueFollowupMatchesForTable = async (tournamentId, tableNumber) => {
  let matches = await buildMatches(tournamentId, await buildTeams(tournamentId));
  let tableMatches = matches.filter((match) => match.table_number === tableNumber);

  while (true) {
    const pendingWinners = getPendingWinnersForTable(matches, tableNumber);

    if (pendingWinners.length < 2) {
      break;
    }

    const queueIndex = Math.max(0, ...tableMatches.map((match) => match.queue_index)) + 1;

    await collections.matches.insertOne({
      tournament_id: tournamentId,
      table_number: tableNumber,
      queue_index: queueIndex,
      team_a_id: pendingWinners[0].teamId,
      team_b_id: pendingWinners[1].teamId,
      status: "queued",
      winner_team_id: null,
      completed_at: null,
      created_at: now().toISOString(),
    });

    matches = await buildMatches(tournamentId, await buildTeams(tournamentId));
    tableMatches = matches.filter((match) => match.table_number === tableNumber);
  }
};

const ensureFinalMatchForTournament = async (tournamentId) => {
  const teams = await buildTeams(tournamentId);
  const matches = await buildMatches(tournamentId, teams);
  const existingFinal = matches.find((match) => match.table_number === 3);

  if (existingFinal) {
    return existingFinal;
  }

  const tableOneChampion = getTableChampionTeamId(matches, 1);
  const tableTwoChampion = getTableChampionTeamId(matches, 2);

  if (!tableOneChampion || !tableTwoChampion) {
    return null;
  }

  const result = await collections.matches.insertOne({
    tournament_id: tournamentId,
    table_number: 3,
    queue_index: 1,
    team_a_id: tableOneChampion,
    team_b_id: tableTwoChampion,
    status: "queued",
    winner_team_id: null,
    completed_at: null,
    created_at: now().toISOString(),
  });

  return serialize(await collections.matches.findOne({ _id: result.insertedId }));
};

const getTournamentState = async () => {
  const tournament = await ensureTournamentForToday();
  const registrations = await listRegistrationsByTournament(tournament.id);
  const teams = await buildTeams(tournament.id);
  const matches = await buildMatches(tournament.id, teams);
  const drawProgress =
    serialize(
      await collections.drawProgress.findOne({ tournament_id: tournament.id }),
    ) || { reveal_count: 0 };

  const paidPlayers = registrations.filter((entry) => entry.paid);
  const paidNonVolunteerPlayers = paidPlayers.filter(
    (entry) => !entry.is_volunteer,
  );
  const pendingPlayers = registrations.filter((entry) => !entry.paid);
  const currentTime = now();
  const countdownMs = tournament.draw_begins_at
    ? Math.max(dayjs(tournament.draw_begins_at).valueOf() - currentTime.valueOf(), 0)
    : 0;

  const tables = [1, 2].map((tableNumber) => {
    const tableMatches = matches.filter((match) => match.table_number === tableNumber);
    const upcomingMatches = tableMatches.filter((match) => match.status === "queued");

    return {
      tableNumber,
      currentMatch: tableMatches.find((match) => match.status === "live") || null,
      nextMatch: upcomingMatches[0] || null,
      upcomingMatches,
      history: tableMatches.filter((match) => match.status === "completed"),
    };
  });

  const finalMatch =
    matches.find((match) => match.table_number === 3 && match.status === "live") ||
    matches.find((match) => match.table_number === 3 && match.status === "queued") ||
    matches.find((match) => match.table_number === 3 && match.status === "completed") ||
    null;

  const winCountByTeam = new Map();
  for (const match of matches) {
    if (match.winner_team_id) {
      winCountByTeam.set(
        match.winner_team_id,
        (winCountByTeam.get(match.winner_team_id) || 0) + 1,
      );
    }
  }

  const finalWinner =
    finalMatch?.status === "completed" && finalMatch.winner
      ? [
          {
            id: finalMatch.winner.id,
            name: finalMatch.winner.name,
            members: finalMatch.winner.members,
            wins: (winCountByTeam.get(finalMatch.winner.id) || 0) + 1,
          },
        ]
      : [];
  const highestWinCount = Math.max(0, ...winCountByTeam.values());
  const winners = finalWinner.length
    ? finalWinner
    : highestWinCount > 0
      ? teams
          .filter((team) => (winCountByTeam.get(team.id) || 0) === highestWinCount)
          .map((team) => ({
            id: team.id,
            name: team.name,
            members: team.members,
            wins: highestWinCount,
          }))
      : [];

  const completedTournaments = (
    await collections.tournaments
      .find({ status: "completed" })
      .sort({ created_at: -1 })
      .toArray()
  ).map(serialize);

  const history = [];
  for (const pastTournament of completedTournaments) {
    const pastRegistrations = await listRegistrationsByTournament(pastTournament.id);
    const pastTeams = await buildTeams(pastTournament.id);
    const pastMatches = await buildMatches(pastTournament.id, pastTeams);
    const pastWinCountByTeam = new Map();

    for (const match of pastMatches) {
      if (match.winner_team_id) {
        pastWinCountByTeam.set(
          match.winner_team_id,
          (pastWinCountByTeam.get(match.winner_team_id) || 0) + 1,
        );
      }
    }

    const topWins = Math.max(0, ...pastWinCountByTeam.values());
    const pastWinners =
      topWins > 0
        ? pastTeams
            .filter((team) => (pastWinCountByTeam.get(team.id) || 0) === topWins)
            .map((team) => ({
              id: team.id,
              name: team.name,
              members: team.members,
              wins: topWins,
            }))
        : [];

    history.push({
      id: pastTournament.id,
      date_key: pastTournament.date_key,
      created_at: pastTournament.created_at,
      registeredCount: pastRegistrations.length,
      paidCount: pastRegistrations.filter(
        (entry) => entry.paid && !entry.is_volunteer,
      ).length,
      registeredPlayers: pastRegistrations.map((entry) => ({
        id: entry.id,
        name: entry.name,
        paid: Boolean(entry.paid),
        isVolunteer: Boolean(entry.is_volunteer),
        paidAt: entry.paid_at,
      })),
      paidPlayers: pastRegistrations
        .filter((entry) => entry.paid && !entry.is_volunteer)
        .map((entry) => entry.name),
      results: pastMatches
        .filter((match) => match.status === "completed")
        .map((match) => ({
          id: match.id,
          tableNumber: match.table_number,
          teamA: match.teamA,
          teamB: match.teamB,
          winner: match.winner,
        })),
      winners: pastWinners,
    });
  }

  const staffUsers = (await collections.staffUsers.find({}).sort({ role: 1, username: 1 }).toArray()).map(serialize).map((user) => ({
    id: user.id,
    username: user.username,
    role: user.role,
  }));

  return {
    timezone: APP_TIMEZONE,
    tournament: {
      ...tournament,
      countdownSeconds: Math.ceil(countdownMs / 1000),
      registrationOpen: tournament.status === "registration_open",
      drawScreenVisible: ["countdown", "draw_revealing", "live_matches"].includes(
        tournament.status,
      ),
      registrationCount: registrations.length,
      paidCount: paidNonVolunteerPlayers.length,
      pendingCount: pendingPlayers.length,
      revealedCount: drawProgress.reveal_count,
      winners,
    },
    public: {
      registrationBoard: registrations.map((entry) => ({
        id: entry.id,
        name: entry.name,
        confirmed: Boolean(entry.paid),
        isVolunteer: Boolean(entry.is_volunteer),
      })),
      confirmedPlayers: paidPlayers.map((entry) => ({
        id: entry.id,
        name: entry.name,
      })),
      revealedTeams: teams.slice(0, drawProgress.reveal_count),
      waitingPlayer:
        paidPlayers.length % 2 === 1 ? paidPlayers[paidPlayers.length - 1]?.name : null,
      tables,
      finalMatch,
      winners,
    },
    admin: {
      staffUsers,
      pendingPlayers,
      confirmedPlayers: paidPlayers.map((entry) => ({
        ...entry,
        is_volunteer: Boolean(entry.is_volunteer),
      })),
      teams,
      matches,
      tables,
      finalMatch,
      history,
    },
  };
};

const emitTournamentState = async () => {
  io.emit("tournament:state", await getTournamentState());
};

const sendPushNotification = async (title, body, data = {}) => {
  if (!WEB_PUSH_ENABLED) {
    return;
  }

  const subscriptions = (await collections.pushSubscriptions.find({}).toArray()).map(serialize);

  await Promise.all(
    subscriptions.map(async (subscriptionRow) => {
      try {
        await webpush.sendNotification(subscriptionRow.subscription_json, JSON.stringify({
          title,
          body,
          icon: "/pwa-icon.svg",
          badge: "/pwa-icon.svg",
          data,
        }));
      } catch (error) {
        if (error?.statusCode === 404 || error?.statusCode === 410) {
          await collections.pushSubscriptions.deleteOne({ endpoint: subscriptionRow.endpoint });
        } else {
          console.error("Push notification error:", error?.message || error);
        }
      }
    }),
  );
};

const stopRevealTimer = (tournamentId) => {
  const timer = revealTimers.get(tournamentId);
  if (timer) {
    clearInterval(timer);
    revealTimers.delete(tournamentId);
  }
};

const startRevealSequence = async (tournamentId) => {
  stopRevealTimer(tournamentId);
  const tournamentState = await getTournamentState();
  const totalTeams = tournamentState.admin.teams.length;

  if (!totalTeams) {
    await setTournamentLifecycle(tournamentId, {
      status: "live_matches",
      drawCompletedAt: now().toISOString(),
    });
    await emitTournamentState();
    return;
  }

  const timer = setInterval(() => {
    void (async () => {
      const progress =
        serialize(
          await collections.drawProgress.findOne({ tournament_id: tournamentId }),
        ) || { reveal_count: 0 };
      const nextCount = progress.reveal_count + 1;
      await collections.drawProgress.updateOne(
        { tournament_id: tournamentId },
        { $set: { tournament_id: tournamentId, reveal_count: nextCount } },
        { upsert: true },
      );

      if (nextCount >= totalTeams) {
        stopRevealTimer(tournamentId);
        await setTournamentLifecycle(tournamentId, {
          status: "live_matches",
          drawCompletedAt: now().toISOString(),
        });
      }

      await emitTournamentState();
    })().catch(console.error);
  }, DRAW_REVEAL_INTERVAL_MS);

  revealTimers.set(tournamentId, timer);
};

const syncLifecycle = async () => {
  const tournament = await ensureTournamentForToday();

  if (
    tournament.status === "countdown" &&
    tournament.draw_begins_at &&
    now().isAfter(dayjs(tournament.draw_begins_at))
  ) {
    const fresh = await createDrawForTournament(tournament.id);
    await startRevealSequence(fresh.id);
  } else if (
    tournament.status === "draw_revealing" &&
    !revealTimers.has(tournament.id)
  ) {
    await startRevealSequence(tournament.id);
  }

  await emitTournamentState();
};

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

app.use(express.json());

const createToken = (user) =>
  jwt.sign(
    {
      username: user.username,
      role: user.role,
      isPrimary: Boolean(user.isPrimary),
    },
    JWT_SECRET,
    {
      expiresIn: "12h",
    },
  );

const authenticate = (allowedRoles = []) => async (request, response, next) => {
  const header = request.headers.authorization;

  if (!header?.startsWith("Bearer ")) {
    response.status(401).json({ error: "Unauthorized." });
    return;
  }

  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);

    if (!payload.isPrimary) {
      const staffUser = serialize(
        await collections.staffUsers.findOne({
          normalized_name: normalizeName(payload.username),
        }),
      );

      if (!staffUser || staffUser.role !== payload.role) {
        response.status(401).json({ error: "This staff user is no longer active." });
        return;
      }
    }

    if (allowedRoles.length && !allowedRoles.includes(payload.role)) {
      response.status(403).json({ error: "Forbidden." });
      return;
    }

    request.user = payload;
    next();
  } catch {
    response.status(401).json({ error: "Invalid token." });
  }
};

const requirePrimaryAdmin = (request, response, next) => {
  if (!request.user?.isPrimary) {
    response.status(403).json({ error: "Only the primary admin can manage staff users." });
    return;
  }
  next();
};

app.get("/api/state", async (_request, response) => {
  response.json(await getTournamentState());
});

app.get("/api/push/public-key", (_request, response) => {
  if (!WEB_PUSH_ENABLED) {
    response.status(503).json({ error: "Push notifications are not configured yet." });
    return;
  }

  response.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post("/api/push/subscribe", async (request, response) => {
  if (!WEB_PUSH_ENABLED) {
    response.status(503).json({ error: "Push notifications are not configured yet." });
    return;
  }

  const subscription = request.body?.subscription;
  if (!subscription?.endpoint) {
    response.status(400).json({ error: "Invalid push subscription." });
    return;
  }

  const timestamp = now().toISOString();
  await collections.pushSubscriptions.updateOne(
    { endpoint: subscription.endpoint },
    {
      $set: {
        endpoint: subscription.endpoint,
        subscription_json: subscription,
        user_agent: String(request.headers["user-agent"] || ""),
        updated_at: timestamp,
      },
      $setOnInsert: { created_at: timestamp },
    },
    { upsert: true },
  );

  response.status(201).json({ message: "Push notifications enabled." });
});

app.post("/api/push/unsubscribe", async (request, response) => {
  const endpoint = String(request.body?.endpoint || "");

  if (!endpoint) {
    response.status(400).json({ error: "Missing endpoint." });
    return;
  }

  await collections.pushSubscriptions.deleteOne({ endpoint });
  response.json({ message: "Push notifications disabled." });
});

app.post("/api/access", async (request, response) => {
  const username = String(request.body?.username || "").trim();
  const normalizedName = normalizeName(username);

  if (!username) {
    response.status(400).json({ error: "Enter a valid name." });
    return;
  }

  if (username === ADMIN_USER.username) {
    response.json({ requiresPassword: true, role: "admin" });
    return;
  }

  const staffUser = serialize(
    await collections.staffUsers.findOne({ normalized_name: normalizedName }),
  );

  if (!staffUser) {
    response.json({ access: "public" });
    return;
  }

  response.json({
    access: "staff",
    role: staffUser.role,
    username: staffUser.username,
    token: createToken({
      username: staffUser.username,
      role: staffUser.role,
      isPrimary: false,
    }),
  });
});

app.post("/api/register", async (request, response) => {
  const tournament = await ensureTournamentForToday();
  const name = String(request.body?.name || "").trim();

  if (tournament.status !== "registration_open") {
    response.status(400).json({ error: "Registration is currently closed." });
    return;
  }

  if (name.length < 2) {
    response.status(400).json({ error: "Enter a valid name." });
    return;
  }

  try {
    await collections.registrations.insertOne({
      tournament_id: tournament.id,
      name,
      normalized_name: normalizeName(name),
      paid: false,
      is_volunteer: false,
      created_at: now().toISOString(),
      paid_at: null,
    });
    await emitTournamentState();
    response.status(201).json({
      message:
        "Registration received. Please pay at the cashier desk to confirm your spot.",
    });
  } catch (error) {
    if (error?.code === 11000) {
      response.status(409).json({
        error: "That name is already registered for today's tournament.",
      });
      return;
    }

    throw error;
  }
});

app.post("/api/login", (request, response) => {
  const username = String(request.body?.username || "").trim();
  const password = String(request.body?.password || "");

  if (username !== ADMIN_USER.username || password !== ADMIN_USER.password) {
    response.status(401).json({ error: "Incorrect username or password." });
    return;
  }

  response.json({
    token: createToken(ADMIN_USER),
    role: ADMIN_USER.role,
    username: ADMIN_USER.username,
    isPrimary: true,
  });
});

app.post(
  "/api/admin/staff-users",
  authenticate(["admin"]),
  requirePrimaryAdmin,
  async (request, response) => {
    const username = String(request.body?.username || "").trim();
    const role = String(request.body?.role || "").trim();

    if (!["admin", "cashier"].includes(role)) {
      response.status(400).json({ error: "Invalid staff role." });
      return;
    }

    if (username.length < 3) {
      response.status(400).json({ error: "Enter a valid staff username." });
      return;
    }

    if (username === ADMIN_USER.username) {
      response.status(409).json({ error: "That username is already reserved." });
      return;
    }

    try {
      await collections.staffUsers.insertOne({
        username,
        normalized_name: normalizeName(username),
        role,
        created_at: now().toISOString(),
      });
      await emitTournamentState();
      response.status(201).json({ message: `${role} user created successfully.` });
    } catch (error) {
      if (error?.code === 11000) {
        response.status(409).json({ error: "That staff username already exists." });
        return;
      }

      throw error;
    }
  },
);

app.delete(
  "/api/admin/staff-users/:staffUserId",
  authenticate(["admin"]),
  requirePrimaryAdmin,
  async (request, response) => {
    const objectId = getObjectId(request.params.staffUserId);

    if (!objectId) {
      response.status(404).json({ error: "Staff user not found." });
      return;
    }

    const result = await collections.staffUsers.deleteOne({ _id: objectId });

    if (!result.deletedCount) {
      response.status(404).json({ error: "Staff user not found." });
      return;
    }

    await emitTournamentState();
    response.json({ message: "Staff user deleted." });
  },
);

app.post(
  "/api/admin/open-registration",
  authenticate(["admin"]),
  async (_request, response) => {
    const tournament = await ensureTournamentForToday();

    if (
      ["registration_open", "countdown", "draw_revealing", "live_matches"].includes(
        tournament.status,
      )
    ) {
      response.status(400).json({
        error: "There is already a tournament in progress. Finalize it first.",
      });
      return;
    }

    await createTournamentRecord("registration_open");
    await emitTournamentState();
    void sendPushNotification(
      "Beer Pong Tournament",
      "Registration is now open for today's tournament.",
      { url: "/" },
    );
    response.json({ message: "Registration is now open with a fresh tournament." });
  },
);

app.post(
  "/api/admin/finalize-tournament",
  authenticate(["admin"]),
  async (_request, response) => {
    const tournament = await ensureTournamentForToday();

    if (
      !["registration_open", "countdown", "draw_revealing", "live_matches"].includes(
        tournament.status,
      )
    ) {
      response.status(400).json({ error: "There is no active tournament to finalize." });
      return;
    }

    await finalizeTournament(tournament.id);
    await emitTournamentState();
    void sendPushNotification(
      "Tournament completed",
      "The tournament has ended. Open the app to see the winners.",
      { url: "/" },
    );
    response.json({ message: "Tournament finalized." });
  },
);

app.post(
  "/api/admin/close-registration",
  authenticate(["admin"]),
  async (_request, response) => {
    const tournament = await ensureTournamentForToday();

    if (tournament.status !== "registration_open") {
      response.status(400).json({ error: "Registration is not currently open." });
      return;
    }

    const drawBeginsAt = now().add(DRAW_COUNTDOWN_SECONDS, "second").toISOString();
    await setTournamentLifecycle(tournament.id, {
      status: "countdown",
      registrationClosesAt: now().toISOString(),
      drawBeginsAt,
    });
    await emitTournamentState();
    void sendPushNotification(
      "Registration closed",
      "Team draw is about to begin.",
      { url: "/" },
    );
    response.json({ message: "Registration closed. Draw countdown started." });
  },
);

app.post(
  "/api/admin/simulate-registration",
  authenticate(["admin"]),
  async (_request, response) => {
    const tournament = await ensureTournamentForToday();

    if (tournament.status !== "registration_open") {
      response.status(400).json({ error: "Open registration before simulating players." });
      return;
    }

    const existingCount = await collections.registrations.countDocuments({
      tournament_id: tournament.id,
    });

    if (existingCount > 0) {
      response.status(400).json({
        error: "This simulation only works on an empty registration list.",
      });
      return;
    }

    const timestamp = now().toISOString();
    await collections.registrations.insertMany(
      demoPlayers.map((playerName) => ({
        tournament_id: tournament.id,
        name: playerName,
        normalized_name: normalizeName(playerName),
        paid: true,
        is_volunteer: false,
        created_at: timestamp,
        paid_at: timestamp,
      })),
    );

    await emitTournamentState();
    response.json({ message: "20 demo participants were added and confirmed." });
  },
);

app.post(
  "/api/admin/add-volunteer",
  authenticate(["admin"]),
  async (request, response) => {
    const tournament = await ensureTournamentForToday();
    const name = String(request.body?.name || "").trim();

    if (tournament.status !== "registration_open") {
      response.status(400).json({
        error: "Volunteers can only be added while registration is open.",
      });
      return;
    }

    if (name.length < 2) {
      response.status(400).json({ error: "Enter a valid volunteer name." });
      return;
    }

    const timestamp = now().toISOString();

    try {
      await collections.registrations.insertOne({
        tournament_id: tournament.id,
        name,
        normalized_name: normalizeName(name),
        paid: true,
        is_volunteer: true,
        created_at: timestamp,
        paid_at: timestamp,
      });
      await emitTournamentState();
      response.status(201).json({
        message: "Volunteer added and confirmed for the current tournament.",
      });
    } catch (error) {
      if (error?.code === 11000) {
        response.status(409).json({
          error: "That name is already registered for today's tournament.",
        });
        return;
      }

      throw error;
    }
  },
);

app.post(
  "/api/admin/start-draw-now",
  authenticate(["admin"]),
  async (_request, response) => {
    const tournament = await ensureTournamentForToday();

    if (!["countdown", "registration_closed"].includes(tournament.status)) {
      response.status(400).json({ error: "Draw cannot be started right now." });
      return;
    }

    const fresh = await createDrawForTournament(tournament.id);
    await startRevealSequence(fresh.id);
    await emitTournamentState();
    void sendPushNotification("Draw started", "Teams are being revealed right now.", {
      url: "/",
    });
    response.json({ message: "Draw started." });
  },
);

app.post(
  "/api/admin/tables/:tableNumber/start-next",
  authenticate(["admin"]),
  async (request, response) => {
    const tournament = await ensureTournamentForToday();
    const tableNumber = Number(request.params.tableNumber);
    const tableMatches = (await buildMatches(tournament.id, await buildTeams(tournament.id))).filter(
      (match) => match.table_number === tableNumber,
    );

    if (![1, 2, 3].includes(tableNumber)) {
      response.status(400).json({ error: "Invalid table." });
      return;
    }

    if (tableMatches.some((match) => match.status === "live")) {
      response.status(400).json({ error: "This table already has a live match." });
      return;
    }

    const nextMatch = tableMatches.find((match) => match.status === "queued");

    if (!nextMatch) {
      response.status(400).json({ error: "There is no queued match for this table." });
      return;
    }

    await collections.matches.updateOne(
      { _id: getObjectId(nextMatch.id) },
      { $set: { status: "live" } },
    );
    await emitTournamentState();
    void sendPushNotification(
      tableNumber === 3 ? "Final started" : `Table ${tableNumber} started`,
      tableNumber === 3
        ? "The final match is now live."
        : `A new match has started on table ${tableNumber}.`,
      { url: "/" },
    );
    response.json({ message: `Table ${tableNumber} match started.` });
  },
);

app.post(
  "/api/cashier/pay/:registrationId",
  authenticate(["cashier", "admin"]),
  async (request, response) => {
    const registrationId = request.params.registrationId;
    const tournament = await ensureTournamentForToday();
    const registration = serialize(
      await collections.registrations.findOne({ _id: getObjectId(registrationId) }),
    );

    if (!registration || registration.tournament_id !== tournament.id) {
      response.status(404).json({ error: "Registration not found." });
      return;
    }

    if (registration.paid) {
      response.status(400).json({ error: "This player is already confirmed." });
      return;
    }

    await collections.registrations.updateOne(
      { _id: getObjectId(registrationId) },
      { $set: { paid: true, paid_at: now().toISOString() } },
    );
    await emitTournamentState();
    response.json({ message: "Payment confirmed." });
  },
);

app.post(
  "/api/admin/matches/:matchId/complete",
  authenticate(["admin"]),
  async (request, response) => {
    const matchId = request.params.matchId;
    const winnerTeamId = String(request.body?.winnerTeamId || "");
    const match = serialize(
      await collections.matches.findOne({ _id: getObjectId(matchId) }),
    );

    if (!match) {
      response.status(404).json({ error: "Match not found." });
      return;
    }

    if (match.status !== "live") {
      response.status(400).json({ error: "That match is not live." });
      return;
    }

    if (![match.team_a_id, match.team_b_id].includes(winnerTeamId)) {
      response.status(400).json({ error: "Invalid winner." });
      return;
    }

    await collections.matches.updateOne(
      { _id: getObjectId(matchId) },
      {
        $set: {
          status: "completed",
          winner_team_id: winnerTeamId,
          completed_at: now().toISOString(),
        },
      },
    );

    if ([1, 2].includes(match.table_number)) {
      await maybeQueueFollowupMatchesForTable(match.tournament_id, match.table_number);
      await ensureFinalMatchForTournament(match.tournament_id);
    }

    await emitTournamentState();
    response.json({ message: "Match result saved." });
  },
);

if (fs.existsSync(clientDistDir)) {
  app.use(express.static(clientDistDir));
  app.get("*", (request, response, next) => {
    if (request.path.startsWith("/api")) {
      next();
      return;
    }
    response.sendFile(path.join(clientDistDir, "index.html"));
  });
}

io.on("connection", (socket) => {
  void getTournamentState()
    .then((state) => socket.emit("tournament:state", state))
    .catch(console.error);
});

const bootstrap = async () => {
  await mongoClient.connect();
  database = mongoClient.db(MONGODB_DB_NAME);
  collections = {
    tournaments: database.collection("tournaments"),
    registrations: database.collection("registrations"),
    teams: database.collection("teams"),
    teamMembers: database.collection("team_members"),
    matches: database.collection("matches"),
    drawProgress: database.collection("draw_progress"),
    staffUsers: database.collection("staff_users"),
    pushSubscriptions: database.collection("push_subscriptions"),
  };

  await ensureIndexes();
  await syncLifecycle();
  setInterval(() => {
    void syncLifecycle().catch(console.error);
  }, 1000);

  httpServer.listen(PORT, () => {
    console.log(`Beer Pong app running on port ${PORT}`);
  });
};

bootstrap().catch((error) => {
  console.error("Failed to start Beer Pong app:", error);
  process.exit(1);
});
