// Theme toggle (persists per browser) + active nav link.
(function () {
  const root = document.documentElement;
  const isDark = () => (root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
  const btn = document.getElementById("theme");
  const sync = () => btn && (btn.textContent = isDark() ? "☀" : "☾");
  btn?.addEventListener("click", () => {
    root.dataset.theme = isDark() ? "light" : "dark";
    try { localStorage.setItem("clause.docs.theme", root.dataset.theme); } catch (e) { /* private mode */ }
    sync();
  });
  sync();
  const page = location.pathname.split("/").pop() || "index.html";
  document.querySelectorAll(".nav a").forEach((a) => a.getAttribute("href") === page && a.classList.add("on"));
})();
