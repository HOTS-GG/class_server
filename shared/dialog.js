// 공용 대화창 — 브라우저 기본 alert()/confirm()/prompt() 대체.
// Electron은 prompt()를 지원하지 않고, alert/confirm은 창 제목에 실행 파일 이름이 뜨며
// 닫힌 뒤 입력칸 포커스가 풀리는 문제가 있어 화면 안 모달로 대체한다.
// 사용: await csDialog.alert('메시지'); if (await csDialog.confirm('진행할까요?')) { ... }
(function () {
  let root = null;
  let queue = Promise.resolve();

  function ensure() {
    if (root) return root;
    root = document.createElement('div');
    root.id = 'cs-dialog';
    root.className = 'modal hidden';
    root.innerHTML = `
      <div class="modal-body cs-dialog-body" role="dialog" aria-modal="true">
        <h2 class="cs-dialog-title"></h2>
        <div class="cs-dialog-msg"></div>
        <div class="toolbar cs-dialog-actions">
          <span class="sep"></span>
          <button class="cs-dialog-cancel">취소</button>
          <button class="cs-dialog-ok primary">확인</button>
        </div>
      </div>`;
    document.body.appendChild(root);
    return root;
  }

  function show({ title, message, okText = '확인', cancelText = '취소', showCancel, danger = false }) {
    const run = () => new Promise((resolve) => {
      const el = ensure();
      const prevFocus = document.activeElement;
      el.querySelector('.cs-dialog-title').textContent = title ?? '';
      el.querySelector('.cs-dialog-title').style.display = title ? '' : 'none';
      el.querySelector('.cs-dialog-msg').textContent = message ?? '';
      const ok = el.querySelector('.cs-dialog-ok');
      const cancel = el.querySelector('.cs-dialog-cancel');
      ok.textContent = okText;
      ok.className = `cs-dialog-ok ${danger ? 'danger' : 'primary'}`;
      cancel.textContent = cancelText;
      cancel.style.display = showCancel ? '' : 'none';
      el.classList.remove('hidden');

      const finish = (value) => {
        el.classList.add('hidden');
        document.removeEventListener('keydown', onKey, true);
        ok.onclick = null; cancel.onclick = null; el.onclick = null;
        // 대화창을 닫은 뒤 원래 입력칸으로 포커스 복귀 (Electron alert 후 입력 불가 문제 방지)
        if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus)) {
          setTimeout(() => prevFocus.focus(), 0);
        }
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
      };
      document.addEventListener('keydown', onKey, true);
      ok.onclick = () => finish(true);
      cancel.onclick = () => finish(false);
      el.onclick = (e) => { if (e.target === el && showCancel) finish(false); };
      setTimeout(() => ok.focus(), 0);
    });
    // 대화창이 겹치지 않도록 순서대로
    const p = queue.then(run, run);
    queue = p.then(() => {}, () => {});
    return p;
  }

  window.csDialog = {
    alert: (message, opts = {}) => show({ ...opts, message, showCancel: false }),
    confirm: (message, opts = {}) => show({ ...opts, message, showCancel: true }),
  };
})();
