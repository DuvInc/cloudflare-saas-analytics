/*
  rrweb-player, loaded only when a replay is opened. It fills its column at the recorded screen's
  ratio and follows the column when it changes size (phone rotation, sidebar), since the player
  itself only takes a fixed width and height.
*/
import rrwebPlayer from "rrweb-player";
import "rrweb-player/dist/style.css";

const CONTROLLER = 80;
const SPEED_KEY = "csa_replay_speed";
const SPEEDS = [1, 2, 4, 8];

function getSavedSpeed(): number {
  try {
    const val = Number(localStorage.getItem(SPEED_KEY));
    if (SPEEDS.includes(val)) return val;
  } catch {}
  return 1;
}

function saveSpeed(s: number) {
  try {
    if (SPEEDS.includes(s)) localStorage.setItem(SPEED_KEY, String(s));
  } catch {}
}

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const remS = s % 60;
  return `${String(m).padStart(2, "0")}:${String(remS).padStart(2, "0")}`;
}

(window as any).csaPlayer = (el: HTMLElement, events: any[]) => {
  if ((el as any)._csaDestroy) {
    try { (el as any)._csaDestroy(); } catch {}
  }
  el.innerHTML = "";
  const meta = events.find((e) => e.type === 4)?.data ?? { width: 1440, height: 900 };
  const size = () => {
    const width = Math.max(Math.floor(el.getBoundingClientRect().width), 240);
    const height = Math.min(Math.round((width * meta.height) / meta.width), Math.round(window.innerHeight * 0.72));
    return { width, height };
  };
  const first = size();
  const savedSpeed = getSavedSpeed();
  const player = new rrwebPlayer({
    target: el,
    props: {
      events,
      width: first.width,
      height: first.height + CONTROLLER,
      autoPlay: true,
      speed: savedSpeed,
      skipInactive: true,
      showController: true,
      mouseTail: false,
    },
  });

  const progress = el.querySelector<HTMLElement>(".rr-progress");
  if (progress) {
    const metaData = (player as any).getMetaData?.();
    let minTime = Infinity;
    let maxTime = -Infinity;
    for (const e of events) {
      if (typeof e.timestamp === "number") {
        if (e.timestamp < minTime) minTime = e.timestamp;
        if (e.timestamp > maxTime) maxTime = e.timestamp;
      }
    }
    const start = metaData?.startTime ?? (minTime !== Infinity ? minTime : 0);
    const total = metaData?.totalTime ?? Math.max(maxTime - minTime, 1);

    const clicksContainer = document.createElement("div");
    clicksContainer.className = "csa-timeline-clicks";

    let lastClickTime = -Infinity;
    for (const e of events) {
      if (e.type === 3 && e.data?.source === 2 && (e.data?.type === 2 || e.data?.type === 9)) {
        if (e.timestamp - lastClickTime < 150) continue;
        lastClickTime = e.timestamp;
        const offset = Math.max(0, e.timestamp - start);
        const pct = Math.min(100, Math.max(0, (offset / total) * 100));

        const tick = document.createElement("button");
        tick.type = "button";
        tick.className = "csa-click-tick";
        tick.style.left = `${pct.toFixed(2)}%`;
        tick.title = `Click · ${formatTime(offset)}`;
        tick.setAttribute("aria-label", `Click at ${formatTime(offset)}`);
        tick.addEventListener("click", (evt) => {
          evt.stopPropagation();
          (player as any).goto?.(offset);
        });
        clicksContainer.appendChild(tick);
      }
    }
    progress.appendChild(clicksContainer);
  }

  if (savedSpeed !== 1 && typeof (player as any).setSpeed === "function") {
    try { (player as any).setSpeed(savedSpeed); } catch {}
  }
  if (typeof (player as any).play === "function") {
    try { (player as any).play(); } catch {}
  }

  const onClick = (e: MouseEvent) => {
    const btn = (e.target as HTMLElement | null)?.closest("button");
    if (!btn) return;
    const match = btn.textContent?.trim().match(/^([0-9.]+)x$/);
    if (match) {
      const s = Number(match[1]);
      saveSpeed(s);
    }
  };
  el.addEventListener("click", onClick);

  try {
    const replayer = (player as any).getReplayer?.();
    if (replayer && typeof replayer.setConfig === "function") {
      const origSetConfig = replayer.setConfig.bind(replayer);
      replayer.setConfig = (config: any) => {
        if (typeof config?.speed === "number") {
          saveSpeed(config.speed);
        }
        return origSetConfig(config);
      };
    }
  } catch {}

  let last = first.width;
  const ro = new ResizeObserver(() => {
    const s = size();
    if (Math.abs(s.width - last) < 4) return;
    last = s.width;
    (player as any).$set({ width: s.width, height: s.height + CONTROLLER });
    (player as any).triggerResize?.();
  });
  ro.observe(el);

  (el as any)._csaDestroy = () => {
    el.removeEventListener("click", onClick);
    ro.disconnect();
    try { (player as any).$destroy?.(); } catch {}
  };
};
