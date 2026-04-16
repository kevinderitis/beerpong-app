import { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";

const socket = io("/", { autoConnect: true });
const ADMIN_TRIGGER_NAME = "AdminArenaBeerPong8768";
const HISTORY_PAGE_SIZE = 2;

const detectInstallPlatform = () => {
  const userAgent = navigator.userAgent || "";

  if (/iPhone|iPad|iPod/i.test(userAgent)) {
    return "ios";
  }

  if (/Android/i.test(userAgent)) {
    return "android";
  }

  return "desktop";
};

const urlBase64ToUint8Array = (base64String) => {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const normalized = (base64String + padding).replaceAll("-", "+").replaceAll("_", "/");
  const rawData = window.atob(normalized);

  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
};

const api = async (path, options = {}) => {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.token
        ? { Authorization: `Bearer ${options.token}` }
        : {}),
    },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Something went wrong.");
  }
  return payload;
};

const formatLongDate = (value, timezone) =>
  new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: timezone,
  }).format(new Date(value));

const formatClock = (value, timezone) =>
  new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(value));

const formatCountdown = (seconds) => {
  const safe = Math.max(seconds || 0, 0);
  const minutes = String(Math.floor(safe / 60)).padStart(2, "0");
  const remaining = String(safe % 60).padStart(2, "0");
  return `${minutes}:${remaining}`;
};

const formatTournamentStamp = (value) =>
  new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));

const buildDrawMatchups = (teams) => {
  const matchups = [];

  for (let index = 0; index < teams.length; index += 2) {
    matchups.push({
      id: `draw-${index}`,
      teamA: teams[index] || null,
      teamB: teams[index + 1] || null,
    });
  }

  return matchups;
};

function App() {
  const [state, setState] = useState(null);
  const [name, setName] = useState("");
  const [feedback, setFeedback] = useState("");
  const [adminPasswordOpen, setAdminPasswordOpen] = useState(false);
  const [adminPassword, setAdminPassword] = useState("");
  const [volunteerName, setVolunteerName] = useState("");
  const [staffUsername, setStaffUsername] = useState("");
  const [staffRole, setStaffRole] = useState("admin");
  const [manageOpen, setManageOpen] = useState(false);
  const [historyPanelOpen, setHistoryPanelOpen] = useState(false);
  const [expandedHistory, setExpandedHistory] = useState({});
  const [historySearch, setHistorySearch] = useState("");
  const [historyPage, setHistoryPage] = useState(1);
  const [installHelpOpen, setInstallHelpOpen] = useState(false);
  const [installPlatform, setInstallPlatform] = useState("desktop");
  const [notificationSupported, setNotificationSupported] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState("default");
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [busy, setBusy] = useState("");
  const [expandedQueues, setExpandedQueues] = useState({});
  const [publicRegistrationState, setPublicRegistrationState] = useState(() => {
    const saved = localStorage.getItem("beerpong-public-registration");

    if (!saved) {
      return { registered: false, dateKey: null };
    }

    try {
      return JSON.parse(saved);
    } catch {
      return { registered: false, dateKey: null };
    }
  });
  const [auth, setAuth] = useState(() => {
    const saved = localStorage.getItem("beerpong-auth");
    return saved ? JSON.parse(saved) : null;
  });

  useEffect(() => {
    api("/api/state").then(setState).catch(console.error);

    const handleState = (nextState) => setState(nextState);
    socket.on("tournament:state", handleState);
    return () => socket.off("tournament:state", handleState);
  }, []);

  useEffect(() => {
    if (auth) {
      localStorage.setItem("beerpong-auth", JSON.stringify(auth));
    } else {
      localStorage.removeItem("beerpong-auth");
    }
  }, [auth]);

  useEffect(() => {
    localStorage.setItem("beerpong-public-registration", JSON.stringify(publicRegistrationState));
  }, [publicRegistrationState]);

  useEffect(() => {
    setInstallPlatform(detectInstallPlatform());
    setNotificationSupported(
      "serviceWorker" in navigator &&
        "PushManager" in window &&
        "Notification" in window,
    );
    if ("Notification" in window) {
      setNotificationPermission(Notification.permission);
    }
  }, []);

  const isAdmin = auth?.role === "admin";
  const isCashier = auth?.role === "cashier";
  const publicRegistrationDone =
    Boolean(publicRegistrationState?.registered) &&
    publicRegistrationState?.dateKey === state?.tournament?.date_key;
  const tournamentInProgress = [
    "registration_open",
    "countdown",
    "draw_revealing",
    "live_matches",
  ].includes(state?.tournament?.status);
  const formatMatchLabel = (match) =>
    match
      ? `${match.teamA?.members.join(" + ")} vs ${match.teamB?.members.join(" + ")}`
      : "";
  const renderTeamLine = (team, emptyLabel = "Waiting...") => (
    <span className="match-team-line">{team ? team.members.join(" + ") : emptyLabel}</span>
  );
  const renderMatchSummary = (match, emptyLabel) =>
    match ? (
      <div className="match-summary">
        {renderTeamLine(match.teamA)}
        <span className="match-summary-vs">vs</span>
        {renderTeamLine(match.teamB)}
      </div>
    ) : (
      <div className="match-summary is-empty">
        <span>{emptyLabel}</span>
      </div>
    );
  const activeScreen = useMemo(() => {
    if (!state) return "public";
    if (isAdmin) return "admin";
    if (isCashier) return "cashier";
    if (state.tournament.status === "completed" && publicRegistrationDone) {
      return "completed";
    }
    if (!publicRegistrationDone) return "public";
    if (state.tournament.status === "draw_revealing") return "draw";
    if (state.tournament.status === "live_matches") return "live";
    return "public";
  }, [isAdmin, isCashier, publicRegistrationDone, state]);
  const showRegistrationForm =
    activeScreen === "public" &&
    !publicRegistrationDone &&
    state?.tournament?.status === "registration_open";
  const revealedMatchups = buildDrawMatchups(state?.public?.revealedTeams || []);
  const showAdminMatches =
    activeScreen === "admin" &&
    ["live_matches", "completed"].includes(state?.tournament?.status);
  const publicFinalActive =
    state?.public?.finalMatch &&
    ["queued", "live", "completed"].includes(state.public.finalMatch.status);
  const adminFinalActive =
    state?.admin?.finalMatch &&
    ["queued", "live", "completed"].includes(state.admin.finalMatch.status);
  const adminStage = state?.tournament?.status;
  const showAdminOpenOnly =
    activeScreen === "admin" &&
    ["registration_closed", "completed"].includes(adminStage);
  const showAdminRegistration =
    activeScreen === "admin" && adminStage === "registration_open";
  const showAdminDraw =
    activeScreen === "admin" &&
    ["countdown", "draw_revealing"].includes(adminStage);
  const isPrimaryAdmin =
    auth?.role === "admin" &&
    (auth?.isPrimary === true || auth?.username === ADMIN_TRIGGER_NAME);
  const filteredHistory = useMemo(() => {
    const search = historySearch.trim();

    if (!search) {
      return state?.admin?.history || [];
    }

    return (state?.admin?.history || []).filter((item) => item.date_key?.startsWith(search));
  }, [historySearch, state?.admin?.history]);
  const totalHistoryPages = Math.max(
    1,
    Math.ceil(filteredHistory.length / HISTORY_PAGE_SIZE),
  );
  const visibleHistory = filteredHistory.slice(
    (historyPage - 1) * HISTORY_PAGE_SIZE,
    historyPage * HISTORY_PAGE_SIZE,
  );

  useEffect(() => {
    setHistoryPage(1);
  }, [historySearch]);

  useEffect(() => {
    if (historyPage > totalHistoryPages) {
      setHistoryPage(totalHistoryPages);
    }
  }, [historyPage, totalHistoryPages]);

  useEffect(() => {
    setHistoryPanelOpen(!tournamentInProgress);
  }, [tournamentInProgress]);

  const submitRegistration = async (event) => {
    event.preventDefault();
    setBusy("register");
    setFeedback("");
    const trimmedName = name.trim();

    try {
      const accessResult = await api("/api/access", {
        method: "POST",
        body: { username: trimmedName },
      });

      if (accessResult.requiresPassword) {
        setAdminPasswordOpen(true);
        setAdminPassword("");
        return;
      }

      if (accessResult.access === "staff") {
        setAuth(accessResult);
        setName("");
        return;
      }

      if (state?.tournament?.status !== "registration_open") {
        setFeedback("Registration has not opened yet. Please wait for the next tournament.");
        return;
      }

      const result = await api("/api/register", {
        method: "POST",
        body: { name: trimmedName },
      });
      setName("");
      setPublicRegistrationState({
        registered: true,
        dateKey: state?.tournament?.date_key || null,
      });
      setFeedback(result.message);
    } catch (error) {
      setFeedback(error.message);
    } finally {
      setBusy("");
    }
  };

  const submitAdminPassword = async (event) => {
    event.preventDefault();
    setBusy("admin-login");
    setFeedback("");

    try {
      const result = await api("/api/login", {
        method: "POST",
        body: {
          username: ADMIN_TRIGGER_NAME,
          password: adminPassword,
        },
      });
      setAuth(result);
      setAdminPassword("");
      setAdminPasswordOpen(false);
      setName("");
    } catch (error) {
      setFeedback(error.message);
    } finally {
      setBusy("");
    }
  };

  const runAdminAction = async (path, actionId) => {
    setBusy(actionId);
    setFeedback("");
    try {
      const result = await api(path, {
        method: "POST",
        token: auth.token,
      });
      setFeedback(result.message);
    } catch (error) {
      setFeedback(error.message);
    } finally {
      setBusy("");
    }
  };

  const markPaid = async (registrationId) => {
    setBusy(`pay-${registrationId}`);
    setFeedback("");
    try {
      await api(`/api/cashier/pay/${registrationId}`, {
        method: "POST",
        token: auth.token,
      });
    } catch (error) {
      setFeedback(error.message);
    } finally {
      setBusy("");
    }
  };

  const finishMatch = async (matchId, winnerTeamId) => {
    setBusy(`match-${matchId}`);
    setFeedback("");
    try {
      await api(`/api/admin/matches/${matchId}/complete`, {
        method: "POST",
        token: auth.token,
        body: { winnerTeamId },
      });
    } catch (error) {
      setFeedback(error.message);
    } finally {
      setBusy("");
    }
  };

  const startNextMatch = async (tableNumber) => {
    setBusy(`start-${tableNumber}`);
    setFeedback("");
    try {
      await api(`/api/admin/tables/${tableNumber}/start-next`, {
        method: "POST",
        token: auth.token,
      });
    } catch (error) {
      setFeedback(error.message);
    } finally {
      setBusy("");
    }
  };

  const finalizeTournament = async () => {
    await runAdminAction("/api/admin/finalize-tournament", "finalize");
  };

  const openConfirmDialog = ({
    title,
    message,
    actionLabel,
    onConfirm,
    tone = "default",
  }) => {
    setConfirmDialog({
      title,
      message,
      actionLabel,
      onConfirm,
      tone,
    });
  };

  const closeConfirmDialog = () => {
    setConfirmDialog(null);
  };

  const goBackToStart = () => {
    setPublicRegistrationState({ registered: false, dateKey: null });
    setFeedback("");
    setName("");
  };

  const addVolunteer = async (event) => {
    event.preventDefault();
    setBusy("volunteer");
    setFeedback("");

    try {
      const result = await api("/api/admin/add-volunteer", {
        method: "POST",
        token: auth.token,
        body: { name: volunteerName.trim() },
      });
      setVolunteerName("");
      setFeedback(result.message);
    } catch (error) {
      setFeedback(error.message);
    } finally {
      setBusy("");
    }
  };

  const createStaffUser = async (event) => {
    event.preventDefault();
    setBusy("staff-create");
    setFeedback("");

    try {
      const result = await api("/api/admin/staff-users", {
        method: "POST",
        token: auth.token,
        body: {
          username: staffUsername.trim(),
          role: staffRole,
        },
      });
      setStaffUsername("");
      setStaffRole("admin");
      setFeedback(result.message);
    } catch (error) {
      setFeedback(error.message);
    } finally {
      setBusy("");
    }
  };

  const deleteStaffUser = async (staffUserId) => {
    setBusy(`staff-delete-${staffUserId}`);
    setFeedback("");

    try {
      const result = await api(`/api/admin/staff-users/${staffUserId}`, {
        method: "DELETE",
        token: auth.token,
      });
      setFeedback(result.message);
    } catch (error) {
      setFeedback(error.message);
    } finally {
      setBusy("");
    }
  };

  const exitStaffMode = () => {
    setAuth(null);
    setFeedback("");
    setName("");
  };

  const enableNotifications = async () => {
    if (!notificationSupported) {
      setFeedback("Push notifications are not supported on this device/browser.");
      return;
    }

    setBusy("notifications");
    setFeedback("");

    try {
      const permission = await Notification.requestPermission();
      setNotificationPermission(permission);

      if (permission !== "granted") {
        setFeedback("Notification permission was not granted.");
        return;
      }

      const serviceWorker = await navigator.serviceWorker.ready;
      const publicKeyResult = await api("/api/push/public-key");
      const existingSubscription = await serviceWorker.pushManager.getSubscription();
      const subscription =
        existingSubscription ||
        (await serviceWorker.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKeyResult.publicKey),
        }));

      await api("/api/push/subscribe", {
        method: "POST",
        body: { subscription },
      });

      setFeedback("Push notifications are enabled.");
    } catch (error) {
      setFeedback(error.message || "Could not enable notifications.");
    } finally {
      setBusy("");
    }
  };

  const renderHistoryPanel = () => (
    <section className="panel history-panel">
      <div className="section-head">
        <div>
          <p className="kicker">History</p>
          <h2>Past tournaments</h2>
        </div>
        <button
          type="button"
          className="secondary-button"
          onClick={() => setHistoryPanelOpen((current) => !current)}
        >
          {historyPanelOpen ? "Hide history" : "Show history"}
        </button>
      </div>

      {historyPanelOpen ? (
        <>
      <div className="history-toolbar">
        <div className="history-search-shell">
          <input
            type="date"
            value={historySearch}
            onChange={(event) => setHistorySearch(event.target.value)}
          />
          {historySearch ? (
            <button
              type="button"
              className="secondary-button history-clear-button"
              onClick={() => setHistorySearch("")}
            >
              Clear
            </button>
          ) : null}
        </div>
      </div>

      <div className="history-list">
        {visibleHistory.length ? (
          visibleHistory.map((item) => {
            const expanded = Boolean(expandedHistory[item.id]);
            return (
              <article className="history-card is-collapsible" key={item.id}>
                <button
                  type="button"
                  className="history-toggle"
                  onClick={() =>
                    setExpandedHistory((current) => ({
                      ...current,
                      [item.id]: !current[item.id],
                    }))
                  }
                >
                  <div className="history-head">
                    <strong>{formatLongDate(item.created_at, state.timezone)}</strong>
                    <span>{item.paidCount} paid</span>
                  </div>
                  <span className="history-expand-label">
                    {expanded ? "Hide details" : "View details"}
                  </span>
                </button>

                {expanded && (
                  <div className="history-body">
                    <div className="history-block">
                      <span className="kicker">Players</span>
                      <div className="history-player-list">
                        {item.registeredPlayers.map((player) => (
                          <div className="history-player-row" key={player.id}>
                            <span>{player.name}</span>
                            <span>
                              {player.isVolunteer
                                ? "Volunteer"
                                : player.paid
                                  ? "Paid"
                                  : "Pending"}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="history-block">
                      <span className="kicker">Winners</span>
                      {item.winners.length ? (
                        item.winners.map((winner) => (
                          <p key={winner.id}>{winner.members.join(" + ")}</p>
                        ))
                      ) : (
                        <p>No winners recorded.</p>
                      )}
                    </div>
                  </div>
                )}
              </article>
            );
          })
        ) : (
          <p className="muted-text">
            {historySearch ? "No tournaments found for that date." : "No completed tournaments yet."}
          </p>
        )}
      </div>

      <div className="history-footer">
        <div className="history-pagination">
          <button
            type="button"
            className="secondary-button"
            onClick={() => setHistoryPage((current) => Math.max(1, current - 1))}
            disabled={historyPage === 1}
          >
            Previous
          </button>
          <span>
            Page {historyPage} / {totalHistoryPages}
          </span>
          <button
            type="button"
            className="secondary-button"
            onClick={() =>
              setHistoryPage((current) => Math.min(totalHistoryPages, current + 1))
            }
            disabled={historyPage === totalHistoryPages}
          >
            Next
          </button>
        </div>
      </div>
        </>
      ) : (
        <p className="muted-text">Tournament history is collapsed. Tap to expand it.</p>
      )}
    </section>
  );

  if (!state) {
    return <div className="loading-screen">Loading tournament...</div>;
  }

  return (
    <div className="app-shell">
      {adminPasswordOpen && (
        <div className="modal-backdrop" onClick={() => setAdminPasswordOpen(false)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="section-head">
              <div>
                <p className="kicker">Admin access</p>
                <h2>Enter password</h2>
              </div>
            </div>

            <form className="stack-form" onSubmit={submitAdminPassword}>
              <input
                type="password"
                value={adminPassword}
                onChange={(event) => setAdminPassword(event.target.value)}
                placeholder="Password"
              />
              <button type="submit" disabled={busy === "admin-login"}>
                {busy === "admin-login" ? "Signing in..." : "Enter admin"}
              </button>
            </form>
          </div>
        </div>
      )}

      {installHelpOpen && (
        <div className="modal-backdrop" onClick={() => setInstallHelpOpen(false)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="section-head">
              <div>
                <p className="kicker">Install app</p>
                <h2>
                  {installPlatform === "ios"
                    ? "Install on iPhone"
                    : installPlatform === "android"
                      ? "Install on Android"
                      : "Install on your device"}
                </h2>
              </div>
            </div>

            <div className="instruction-list">
              {installPlatform === "ios" && (
                <>
                  <p>1. Open this site in Safari.</p>
                  <p>2. Tap the Share button.</p>
                  <p>3. Choose Add to Home Screen.</p>
                  <p>4. Open the installed app and then enable notifications.</p>
                </>
              )}
              {installPlatform === "android" && (
                <>
                  <p>1. Open this site in Chrome.</p>
                  <p>2. Tap the browser menu or install prompt.</p>
                  <p>3. Choose Install app or Add to Home screen.</p>
                  <p>4. Open the installed app and enable notifications.</p>
                </>
              )}
              {installPlatform === "desktop" && (
                <>
                  <p>1. Open this site in Chrome or Edge.</p>
                  <p>2. Use the install icon in the address bar.</p>
                  <p>3. Open the installed app window.</p>
                  <p>4. Enable notifications when prompted.</p>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {confirmDialog && (
        <div className="modal-backdrop" onClick={closeConfirmDialog}>
          <div className="modal-card confirm-card" onClick={(event) => event.stopPropagation()}>
            <div className="section-head">
              <div>
                <p className="kicker">Confirmation</p>
                <h2>{confirmDialog.title}</h2>
              </div>
            </div>

            <p className="feedback confirm-copy">{confirmDialog.message}</p>

            <div className="confirm-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={closeConfirmDialog}
              >
                Cancel
              </button>
              <button
                type="button"
                className={confirmDialog.tone === "danger" ? "danger-button" : ""}
                onClick={async () => {
                  const handler = confirmDialog.onConfirm;
                  closeConfirmDialog();
                  await handler();
                }}
              >
                {confirmDialog.actionLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      <main className="page">
        {activeScreen === "public" &&
          (!publicRegistrationDone ? (
            <section className="public-card public-card-compact welcome-card">
              <img
                className="welcome-brand-badge"
                src="/phangan-arena-badge.svg"
                alt="Phangan Arena"
              />
              <h1 className="welcome-title">Beer Pong Tournament</h1>
              <p className="welcome-schedule">Today at 9:30 PM</p>

              {!showRegistrationForm && (
                <div className="waiting-banner welcome-message">
                  <strong>Please wait for registration to open.</strong>
                  <p className="feedback">
                    The tournament has not started yet. Registration will be available
                    soon.
                  </p>
                </div>
              )}

              <form className="stack-form" onSubmit={submitRegistration}>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Enter your name"
                  disabled={busy === "register"}
                />
                <button type="submit" disabled={busy === "register"}>
                  {busy === "register"
                    ? "Submitting..."
                    : showRegistrationForm
                      ? "Register"
                      : "Continue"}
                </button>
              </form>

              <p className="feedback">{feedback}</p>

              <div className="welcome-utility-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setInstallHelpOpen(true)}
                >
                  How to install the app
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={enableNotifications}
                  disabled={busy === "notifications"}
                >
                  {busy === "notifications"
                    ? "Enabling notifications..."
                    : notificationPermission === "granted"
                      ? "Notifications enabled"
                      : "Enable notifications"}
                </button>
              </div>
            </section>
          ) : (
            <section className="public-card">
              <div className="section-head">
                <div>
                  <p className="kicker">Registration status</p>
                  <h2>Waiting room</h2>
                </div>
              </div>

              <p className="lead">
                Your name was submitted. Please pay at the cashier desk to confirm
                your participation.
              </p>

              <div className="waiting-banner">
                {state.tournament.status === "registration_open" && (
                  <strong>Waiting for payment confirmation</strong>
                )}
                {state.tournament.status === "countdown" && (
                  <strong>Awaiting team draw</strong>
                )}
                {state.tournament.status === "registration_closed" && (
                  <strong>Awaiting team draw</strong>
                )}
              </div>

              <div className="section-head waiting-head">
                <div>
                  <p className="kicker">Live list</p>
                  <h2>Registered players</h2>
                </div>
              </div>

              <div className="public-player-list">
                {state.public.registrationBoard.map((player) => (
                  <div className="public-player-row" key={player.id}>
                    <span>{player.name}</span>
                    <span
                      className={
                        player.confirmed ? "confirmation-pill confirmed" : "confirmation-pill"
                      }
                    >
                      {player.confirmed ? "Confirmed" : "Pending"}
                    </span>
                  </div>
                ))}
              </div>

              <p className="feedback">{feedback}</p>
            </section>
          ))}

        {activeScreen === "draw" && (
          <section className="draw-only-layout">
            <section className="draw-hero">
              <div className="section-head">
                <div>
                  <p className="kicker">Live experience</p>
                  <h2>Drawing teams</h2>
                </div>
              </div>

              <div className="draw-stats">
                <div className="info-tile">
                  <span>Confirmed players</span>
                  <strong>{state.public.confirmedPlayers.length}</strong>
                </div>
                <div className="info-tile">
                  <span>Players assigned</span>
                  <strong>{state.public.revealedTeams.length * 2}</strong>
                </div>
              </div>

              <div className="draw-reveal-list">
                {revealedMatchups.length ? (
                  revealedMatchups.map((matchup, index) => (
                    <article className="draw-match-card" key={matchup.id}>
                      <div className="draw-match-head">
                        <span>Matchup {index + 1}</span>
                      </div>
                      <div className="draw-match-body">
                        {renderTeamLine(matchup.teamA, "Drawing team A...")}
                        <span className="draw-match-vs">vs</span>
                        {renderTeamLine(matchup.teamB, "Drawing team B...")}
                      </div>
                    </article>
                  ))
                ) : (
                  <p className="muted-text">
                    Matchups will appear here live as the random draw builds them.
                  </p>
                )}
              </div>

              {state.public.waitingPlayer ? (
                <div className="waiting-banner">
                  <strong>{state.public.waitingPlayer}</strong>
                  <p className="feedback">Waiting for a partner in this draw.</p>
                </div>
              ) : null}
            </section>
          </section>
        )}

        {activeScreen === "live" && (
          <section className="draw-layout">
            <section className="draw-hero draw-hero-minimized">
              <img
                className="welcome-brand-badge live-brand-badge"
                src="/phangan-arena-badge.svg"
                alt="Phangan Arena"
              />
              <h2 className="live-stage-title">Beer Pong Tournament</h2>
            </section>

            {state.public.finalMatch && (
              <section className="panel final-panel">
                <div className="section-head">
                  <div>
                    <p className="kicker">Final</p>
                    <h2>Final</h2>
                  </div>
                </div>

                <div className="table-slot">
                  <span>Championship match</span>
                  {renderMatchSummary(
                    state.public.finalMatch,
                    "Waiting for both table winners",
                  )}
                </div>
              </section>
            )}

            {!publicFinalActive && (
            <section className="table-grid">
              {state.public.tables.map((table) => (
                <article className="panel" key={table.tableNumber}>
                  <div className="section-head">
                    <div>
                      <p className="kicker">Table {table.tableNumber}</p>
                      <h2>Match queue</h2>
                    </div>
                  </div>

                  <div className="table-slot">
                    <span>Now playing</span>
                    {renderMatchSummary(table.currentMatch, "Waiting for live match")}
                  </div>

                  <div className="table-slot">
                    <span>Next up</span>
                    {renderMatchSummary(table.nextMatch, "No next match yet")}
                  </div>

                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() =>
                      setExpandedQueues((current) => ({
                        ...current,
                        [table.tableNumber]: !current[table.tableNumber],
                      }))
                    }
                  >
                    {expandedQueues[table.tableNumber]
                      ? "Hide full table queue"
                      : "View full table queue"}
                  </button>

                  {expandedQueues[table.tableNumber] && (
                    <div className="queue-list">
                      {table.upcomingMatches.length ? (
                        table.upcomingMatches.map((match, index) => (
                          <div className="queue-row" key={match.id}>
                            <span>#{index + 1}</span>
                            {renderMatchSummary(match, "Queued")}
                          </div>
                        ))
                      ) : (
                        <p className="muted-text">No queued matches for this table.</p>
                      )}
                    </div>
                  )}
                </article>
              ))}
            </section>
            )}
          </section>
        )}

        {activeScreen === "completed" && (
          <section className="public-card">
            <div className="section-head">
              <div>
                <p className="kicker">Tournament completed</p>
                <h2>Thanks for playing</h2>
              </div>
            </div>

            <div className="waiting-banner">
              <strong>The tournament has finished.</strong>
            </div>

            <div className="draw-reveal-list">
              {state.public.winners.length ? (
                state.public.winners.map((winner) => (
                  <article className="team-card" key={winner.id}>
                    <div className="team-meta">
                      <span>Winner</span>
                    </div>
                    <h3>{winner.members.join(" + ")}</h3>
                  </article>
                ))
              ) : (
                <p className="muted-text">No winner data was recorded for this tournament.</p>
              )}
            </div>

            <div className="centered-action">
              <button type="button" onClick={goBackToStart}>
                Back to start
              </button>
            </div>
          </section>
        )}

        {activeScreen === "cashier" && (
          <section className="staff-layout">
            <section className="panel">
              <div className="section-head">
                <div>
                  <p className="kicker">Cashier view</p>
                  <h2>Pending payments</h2>
                </div>
                <button type="button" className="secondary-button" onClick={exitStaffMode}>
                  Exit
                </button>
              </div>

              {state.tournament.status === "registration_open" ? (
                <div className="staff-list">
                  {state.admin.pendingPlayers.length ? (
                    state.admin.pendingPlayers.map((player) => (
                      <div className="staff-row" key={player.id}>
                        <div>
                          <strong>{player.name}</strong>
                          <span>Waiting for payment confirmation</span>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            openConfirmDialog({
                              title: "Confirm payment",
                              message: `Mark ${player.name} as paid for this tournament?`,
                              actionLabel: "Confirm payment",
                              onConfirm: () => markPaid(player.id),
                            })
                          }
                          disabled={busy === `pay-${player.id}`}
                        >
                          {busy === `pay-${player.id}` ? "Saving..." : "Confirm payment"}
                        </button>
                      </div>
                    ))
                  ) : (
                    <p className="muted-text">No pending payments.</p>
                  )}
                </div>
              ) : (
                <div className="waiting-banner">
                  <strong>Cashier actions are available only while registration is open.</strong>
                </div>
              )}
            </section>
          </section>
        )}

        {activeScreen === "admin" && (
          showAdminOpenOnly ? (
            <section className="staff-layout">
              <section className="panel">
                <div className="section-head">
                  <div>
                    <p className="kicker">Admin controls</p>
                    <h2>Tournament actions</h2>
                  </div>
                  <button type="button" className="secondary-button" onClick={exitStaffMode}>
                    Exit
                  </button>
                </div>

                <div className="admin-actions">
                  {isPrimaryAdmin && (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setManageOpen((current) => !current)}
                    >
                      {manageOpen ? "Close manage" : "Manage"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => runAdminAction("/api/admin/open-registration", "open")}
                    disabled={busy === "open"}
                  >
                    Open registration
                  </button>
                </div>

                <p className="feedback">{feedback}</p>
              </section>

              {isPrimaryAdmin && manageOpen && (
                <section className="panel">
                  <div className="section-head">
                    <div>
                      <p className="kicker">Staff access</p>
                      <h2>Manage admins and cashiers</h2>
                    </div>
                  </div>

                  <form className="stack-form" onSubmit={createStaffUser}>
                    <input
                      value={staffUsername}
                      onChange={(event) => setStaffUsername(event.target.value)}
                      placeholder="Staff username"
                      disabled={busy === "staff-create"}
                    />
                    <select
                      value={staffRole}
                      onChange={(event) => setStaffRole(event.target.value)}
                      disabled={busy === "staff-create"}
                    >
                      <option value="admin">Admin</option>
                      <option value="cashier">Cashier</option>
                    </select>
                    <button type="submit" disabled={busy === "staff-create"}>
                      {busy === "staff-create" ? "Creating..." : "Create staff user"}
                    </button>
                  </form>

                  <div className="staff-list compact-list">
                    {state.admin.staffUsers.length ? (
                      state.admin.staffUsers.map((staffUser) => (
                        <div className="staff-row" key={staffUser.id}>
                          <div>
                            <strong>{staffUser.username}</strong>
                            <span>{staffUser.role === "admin" ? "Admin" : "Cashier"}</span>
                          </div>
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => deleteStaffUser(staffUser.id)}
                            disabled={busy === `staff-delete-${staffUser.id}`}
                          >
                            {busy === `staff-delete-${staffUser.id}` ? "Removing..." : "Delete"}
                          </button>
                        </div>
                      ))
                    ) : (
                      <p className="muted-text">No extra staff users yet.</p>
                    )}
                  </div>
                </section>
              )}

              {renderHistoryPanel()}
            </section>
          ) : (
          <section className="staff-layout">
            <section className="panel">
              <div className="section-head">
                <div>
                  <p className="kicker">Admin controls</p>
                  <h2>Tournament actions</h2>
                </div>
                <button type="button" className="secondary-button" onClick={exitStaffMode}>
                  Exit
                </button>
              </div>

              <div className="admin-actions">
                {isPrimaryAdmin && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setManageOpen((current) => !current)}
                  >
                    {manageOpen ? "Close manage" : "Manage"}
                  </button>
                )}
                {!showAdminRegistration && !showAdminDraw ? (
                  <button
                    type="button"
                    onClick={() =>
                      openConfirmDialog({
                        title: "Finalize tournament",
                        message: "Are you sure you want to finalize the current tournament?",
                        actionLabel: "Finalize tournament",
                        onConfirm: finalizeTournament,
                        tone: "danger",
                      })
                    }
                    disabled={busy === "finalize"}
                  >
                    Finalize tournament
                  </button>
                ) : null}
                {showAdminRegistration && (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        runAdminAction("/api/admin/simulate-registration", "simulate")
                      }
                      disabled={
                        busy === "simulate" || state.tournament.status !== "registration_open"
                      }
                    >
                      Simulate registration
                    </button>
                    <button
                      type="button"
                      onClick={() => runAdminAction("/api/admin/close-registration", "close")}
                      disabled={
                        busy === "close" || state.tournament.status !== "registration_open"
                      }
                    >
                      Close registration
                    </button>
                  </>
                )}
                {showAdminDraw && (
                  <button
                    type="button"
                    onClick={() => runAdminAction("/api/admin/start-draw-now", "draw")}
                    disabled={
                      busy === "draw" ||
                      !["countdown", "registration_closed"].includes(
                        state.tournament.status,
                      )
                    }
                  >
                    Start draw now
                  </button>
                )}
              </div>

              <p className="feedback">{feedback}</p>
            </section>

            {isPrimaryAdmin && manageOpen && (
              <section className="panel">
                <div className="section-head">
                  <div>
                    <p className="kicker">Staff access</p>
                    <h2>Manage admins and cashiers</h2>
                  </div>
                </div>

                <form className="stack-form" onSubmit={createStaffUser}>
                  <input
                    value={staffUsername}
                    onChange={(event) => setStaffUsername(event.target.value)}
                    placeholder="Staff username"
                    disabled={busy === "staff-create"}
                  />
                  <select
                    value={staffRole}
                    onChange={(event) => setStaffRole(event.target.value)}
                    disabled={busy === "staff-create"}
                  >
                    <option value="admin">Admin</option>
                    <option value="cashier">Cashier</option>
                  </select>
                  <button type="submit" disabled={busy === "staff-create"}>
                    {busy === "staff-create" ? "Creating..." : "Create staff user"}
                  </button>
                </form>

                <div className="staff-list compact-list">
                  {state.admin.staffUsers.length ? (
                    state.admin.staffUsers.map((staffUser) => (
                      <div className="staff-row" key={staffUser.id}>
                        <div>
                          <strong>{staffUser.username}</strong>
                          <span>{staffUser.role === "admin" ? "Admin" : "Cashier"}</span>
                        </div>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => deleteStaffUser(staffUser.id)}
                          disabled={busy === `staff-delete-${staffUser.id}`}
                        >
                          {busy === `staff-delete-${staffUser.id}` ? "Removing..." : "Delete"}
                        </button>
                      </div>
                    ))
                  ) : (
                    <p className="muted-text">No extra staff users yet.</p>
                  )}
                </div>
              </section>
            )}

            {showAdminRegistration && (
              <section className="panel">
                <div className="section-head">
                  <div>
                    <p className="kicker">Volunteers</p>
                    <h2>Add volunteer player</h2>
                  </div>
                </div>

                <form className="stack-form" onSubmit={addVolunteer}>
                  <input
                    value={volunteerName}
                    onChange={(event) => setVolunteerName(event.target.value)}
                    placeholder="Volunteer name"
                    disabled={busy === "volunteer"}
                  />
                  <button type="submit" disabled={busy === "volunteer"}>
                    {busy === "volunteer" ? "Adding..." : "Add volunteer"}
                  </button>
                </form>
              </section>
            )}

            {showAdminRegistration && (
              <section className="panel">
                <div className="section-head">
                  <div>
                    <p className="kicker">Cashier queue</p>
                    <h2>Pending players</h2>
                  </div>
                </div>

                <div className="staff-list">
                  {state.admin.pendingPlayers.length ? (
                    state.admin.pendingPlayers.map((player) => (
                      <div className="staff-row" key={player.id}>
                        <div>
                          <strong>{player.name}</strong>
                          <span>Registered, not confirmed yet</span>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            openConfirmDialog({
                              title: "Confirm payment",
                              message: `Mark ${player.name} as paid for this tournament?`,
                              actionLabel: "Confirm payment",
                              onConfirm: () => markPaid(player.id),
                            })
                          }
                          disabled={busy === `pay-${player.id}`}
                        >
                          Confirm payment
                        </button>
                      </div>
                    ))
                  ) : (
                    <p className="muted-text">No players waiting for payment.</p>
                  )}
                </div>
              </section>
            )}

            {renderHistoryPanel()}

            {showAdminMatches && state.admin.finalMatch && (
              <section className="panel final-panel">
                <div className="section-head">
                  <div>
                    <p className="kicker">Final</p>
                    <h2>Final</h2>
                  </div>
                </div>

                <div className="live-card">
                  {renderMatchSummary(
                    state.admin.finalMatch,
                    "Waiting for both table winners",
                  )}

                  {state.admin.finalMatch.status === "queued" && (
                    <div className="idle-table">
                      <button
                        type="button"
                        onClick={() => startNextMatch(3)}
                        disabled={busy === "start-3"}
                      >
                        {busy === "start-3" ? "Starting..." : "Start final"}
                      </button>
                    </div>
                  )}

                  {state.admin.finalMatch.status === "live" && (
                    <div className="winner-buttons">
                      <button
                        type="button"
                        onClick={() =>
                          openConfirmDialog({
                            title: "Confirm winner",
                            message: `Confirm ${state.admin.finalMatch.teamA?.name} as the winner of the final?`,
                            actionLabel: `${state.admin.finalMatch.teamA?.name} won`,
                            onConfirm: () =>
                              finishMatch(
                                state.admin.finalMatch.id,
                                state.admin.finalMatch.teamA.id,
                              ),
                          })
                        }
                        disabled={busy === `match-${state.admin.finalMatch.id}`}
                      >
                        {state.admin.finalMatch.teamA?.name} won
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          openConfirmDialog({
                            title: "Confirm winner",
                            message: `Confirm ${state.admin.finalMatch.teamB?.name} as the winner of the final?`,
                            actionLabel: `${state.admin.finalMatch.teamB?.name} won`,
                            onConfirm: () =>
                              finishMatch(
                                state.admin.finalMatch.id,
                                state.admin.finalMatch.teamB.id,
                              ),
                          })
                        }
                        disabled={busy === `match-${state.admin.finalMatch.id}`}
                      >
                        {state.admin.finalMatch.teamB?.name} won
                      </button>
                    </div>
                  )}
                </div>
              </section>
            )}

            {showAdminMatches && !adminFinalActive && (
              <section className="table-grid">
                {state.admin.tables.map((table) => (
                  <article className="panel" key={table.tableNumber}>
                    <div className="section-head">
                      <div>
                        <p className="kicker">Table {table.tableNumber}</p>
                        <h2>Live operations</h2>
                      </div>
                    </div>

                    {table.currentMatch ? (
                      <div className="live-card">
                        <div className="versus-line">
                          <div>
                            <span>{table.currentMatch.teamA?.name}</span>
                            <strong>{table.currentMatch.teamA?.members.join(" + ")}</strong>
                          </div>
                          <em>vs</em>
                          <div>
                            <span>{table.currentMatch.teamB?.name}</span>
                            <strong>{table.currentMatch.teamB?.members.join(" + ")}</strong>
                          </div>
                        </div>
                        <div className="winner-buttons">
                          <button
                            type="button"
                            onClick={() =>
                              openConfirmDialog({
                                title: "Confirm winner",
                                message: `Confirm ${table.currentMatch.teamA?.name} as the winner of this match?`,
                                actionLabel: `${table.currentMatch.teamA?.name} won`,
                                onConfirm: () =>
                                  finishMatch(
                                    table.currentMatch.id,
                                    table.currentMatch.teamA.id,
                                  ),
                              })
                            }
                            disabled={busy === `match-${table.currentMatch.id}`}
                          >
                            {table.currentMatch.teamA?.name} won
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              openConfirmDialog({
                                title: "Confirm winner",
                                message: `Confirm ${table.currentMatch.teamB?.name} as the winner of this match?`,
                                actionLabel: `${table.currentMatch.teamB?.name} won`,
                                onConfirm: () =>
                                  finishMatch(
                                    table.currentMatch.id,
                                    table.currentMatch.teamB.id,
                                  ),
                              })
                            }
                            disabled={busy === `match-${table.currentMatch.id}`}
                          >
                            {table.currentMatch.teamB?.name} won
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="idle-table">
                        <p className="muted-text">No live match on this table.</p>
                        <button
                          type="button"
                          onClick={() => startNextMatch(table.tableNumber)}
                          disabled={
                            busy === `start-${table.tableNumber}` || !table.nextMatch
                          }
                        >
                          {busy === `start-${table.tableNumber}`
                            ? "Starting..."
                            : "Start next match"}
                        </button>
                      </div>
                    )}

                    <div className="table-slot">
                      <span>Next up</span>
                      {renderMatchSummary(table.nextMatch, "No queued match")}
                    </div>

                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() =>
                        setExpandedQueues((current) => ({
                          ...current,
                          [`admin-${table.tableNumber}`]: !current[`admin-${table.tableNumber}`],
                        }))
                      }
                    >
                      {expandedQueues[`admin-${table.tableNumber}`]
                        ? "Hide full table queue"
                        : "View full table queue"}
                    </button>

                    {expandedQueues[`admin-${table.tableNumber}`] && (
                      <div className="queue-list">
                        {table.upcomingMatches.length ? (
                          table.upcomingMatches.map((match, index) => (
                            <div className="queue-row" key={match.id}>
                              <span>#{index + 1}</span>
                              {renderMatchSummary(match, "Queued")}
                            </div>
                          ))
                        ) : (
                          <p className="muted-text">No queued matches.</p>
                        )}
                      </div>
                    )}
                  </article>
                ))}
              </section>
            )}
          </section>
          )
        )}
      </main>
    </div>
  );
}

export default App;
