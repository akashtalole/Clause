// Render cron job: asks the Clause web service to run its maintenance sweep
// (reauthorize PayPal holds past the 3-day honor period, flag overdue milestones).
//   CLAUSE_URL=https://your-app.onrender.com CRON_SECRET=... node scripts/sweep.js
// On Render, CLAUSE_URL is the web service's host (no scheme), injected by the Blueprint.
let url = (process.env.CLAUSE_URL || "http://localhost:3000").replace(/\/$/, "");
if (!/^https?:\/\//.test(url)) url = `https://${url}`;
const res = await fetch(`${url}/api/maintenance/sweep`, { method: "POST", headers: { "x-cron-secret": process.env.CRON_SECRET || "" } });
const body = await res.text();
console.log(res.status, body);
if (!res.ok) process.exit(1);
