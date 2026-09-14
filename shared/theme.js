// 테마(라이트/다크) 전환 — 교사 대시보드·학생 클라이언트 공용 (모듈 아님, <script>로 로드)
// 저장: localStorage 'cs_theme' ('light' | 'dark'). 없으면 OS 설정을 따른다.
(function () {
  const KEY = 'cs_theme';
  const root = document.documentElement;
  const prefersDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;

  function current() {
    let saved = null;
    try { saved = localStorage.getItem(KEY); } catch { /* 저장소 접근 불가 시 OS 설정 */ }
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
    try { localStorage.setItem(KEY, next); } catch { /* noop */ }
    apply(next);
  }

  apply(current());
  document.addEventListener('DOMContentLoaded', () => {
    apply(current());
    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => btn.addEventListener('click', toggle));
  });
  window.csTheme = { current, toggle, apply };
})();
