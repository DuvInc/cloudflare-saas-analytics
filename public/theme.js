/* Theme before first paint, or a dark-mode visitor gets a white flash. */
(function () {
  try {
    var t = localStorage.getItem("csa_theme");
    if (t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches)) {
      document.documentElement.classList.add("dark");
    }
  } catch (e) {}
})();
