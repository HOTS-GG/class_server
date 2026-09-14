// 테마(라이트/다크) + 화면 크기 — 교사 대시보드·학생 클라이언트 공용 (모듈 아님, <script>로 로드)
// 저장: localStorage 'cs_theme' ('light' | 'dark'), 'cs_scale' (배율). 없으면 OS 설정/기본 배율.
(function () {
  const KEY = 'cs_theme';
  const SCALE_KEY = 'cs_scale';
  const SCALES = [
    { value: 0.9, label: '작게 (90%)' },
    { value: 1, label: '보통 (100%)' },
    { value: 1.15, label: '크게 (115%)' },
    { value: 1.3, label: '더 크게 (130%)' },
    { value: 1.5, label: '아주 크게 (150%)' },
  ];
  const DEFAULT_SCALE = 1.15; // 교실 모니터에서 기본이 너무 작다는 피드백 반영
  const root = document.documentElement;
  const prefersDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* noop */ } };

  function current() {
    const saved = read(KEY);
    return saved === 'dark' || saved === 'light' ? saved : (prefersDark() ? 'dark' : 'light');
  }

  function apply(mode) {
    root.setAttribute('data-mode', mode);
    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
      btn.textContent = mode === 'dark' ? '☀️' : '🌙';
      btn.title = mode === 'dark' ? '라이트 모드로' : '다크 모드로';
    });
  }

  function toggle() {
    const next = current() === 'dark' ? 'light' : 'dark';
    write(KEY, next);
    apply(next);
  }

  // ── 화면 크기 ─────────────────────────────
  function currentScale() {
    const n = Number(read(SCALE_KEY));
    return SCALES.some((s) => s.value === n) ? n : DEFAULT_SCALE;
  }

  function applyScale(scale) {
    // Chromium의 zoom: 레이아웃 전체가 배율만큼 커진다 (글자·버튼·표 모두)
    root.style.zoom = String(scale);
    document.querySelectorAll('select[data-scale-select]').forEach((sel) => {
      if (!sel.options.length) {
        sel.innerHTML = SCALES.map((s) => `<option value="${s.value}">${s.label}</option>`).join('');
      }
      sel.value = String(scale);
    });
    document.querySelectorAll('[data-scale-label]').forEach((el) => { el.textContent = `${Math.round(scale * 100)}%`; });
  }

  function setScale(scale) {
    const n = Number(scale);
    if (!SCALES.some((s) => s.value === n)) return;
    write(SCALE_KEY, String(n));
    applyScale(n);
  }

  function stepScale(dir) {
    const idx = SCALES.findIndex((s) => s.value === currentScale());
    const next = SCALES[Math.max(0, Math.min(SCALES.length - 1, idx + dir))];
    setScale(next.value);
  }

  apply(current());
  applyScale(currentScale());
  document.addEventListener('DOMContentLoaded', () => {
    apply(current());
    applyScale(currentScale());
    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => btn.addEventListener('click', toggle));
    document.querySelectorAll('select[data-scale-select]').forEach((sel) => sel.addEventListener('change', () => setScale(sel.value)));
    document.querySelectorAll('[data-scale-up]').forEach((b) => b.addEventListener('click', () => stepScale(1)));
    document.querySelectorAll('[data-scale-down]').forEach((b) => b.addEventListener('click', () => stepScale(-1)));
  });
  window.csTheme = { current, toggle, apply, SCALES, currentScale, setScale, stepScale };
})();
