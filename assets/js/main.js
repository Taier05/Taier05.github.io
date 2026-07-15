(() => {
  const root = document.documentElement;
  const toggle = document.querySelector('.theme-toggle');
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  const savedTheme = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

  if (savedTheme === 'dark' || (!savedTheme && prefersDark)) {
    root.dataset.theme = 'dark';
  }

  const updateThemeMeta = () => {
    if (metaTheme) {
      metaTheme.content = root.dataset.theme === 'dark' ? '#111713' : '#f4f1e8';
    }
  };

  updateThemeMeta();

  toggle?.addEventListener('click', () => {
    const nextTheme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = nextTheme;
    localStorage.setItem('theme', nextTheme);
    updateThemeMeta();
  });

  const year = document.querySelector('#current-year');
  if (year) year.textContent = new Date().getFullYear();

  const searchInput = document.querySelector('#note-search');
  const filterButtons = [...document.querySelectorAll('.filter-button')];
  const noteCards = [...document.querySelectorAll('.note-card')];
  const resultCount = document.querySelector('#notes-result-count');
  const emptyState = document.querySelector('#notes-empty');
  const clearFilters = document.querySelector('#clear-note-filters');
  let activeCategory = 'all';

  const normalize = value => value.trim().toLocaleLowerCase('zh-CN');

  const applyNoteFilters = () => {
    const query = normalize(searchInput?.value || '');
    let visible = 0;

    noteCards.forEach(card => {
      const matchesCategory = activeCategory === 'all' || card.dataset.category === activeCategory;
      const matchesSearch = !query || normalize(card.dataset.search || '').includes(query);
      const shouldShow = matchesCategory && matchesSearch;
      card.hidden = !shouldShow;
      if (shouldShow) visible += 1;
    });

    if (resultCount) resultCount.textContent = visible;
    if (emptyState) emptyState.hidden = visible !== 0;
    if (clearFilters) clearFilters.hidden = activeCategory === 'all' && !query;
  };

  filterButtons.forEach(button => {
    button.addEventListener('click', () => {
      activeCategory = button.dataset.filter || 'all';
      filterButtons.forEach(item => {
        const active = item === button;
        item.classList.toggle('active', active);
        item.setAttribute('aria-pressed', String(active));
      });
      applyNoteFilters();
    });
  });

  searchInput?.addEventListener('input', applyNoteFilters);

  clearFilters?.addEventListener('click', () => {
    activeCategory = 'all';
    if (searchInput) searchInput.value = '';
    filterButtons.forEach(button => {
      const active = button.dataset.filter === 'all';
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    applyNoteFilters();
    searchInput?.focus();
  });

  document.addEventListener('keydown', event => {
    const target = event.target;
    const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
    if (event.key === '/' && !typing && searchInput) {
      event.preventDefault();
      searchInput.focus();
    }
    if (event.key === 'Escape' && document.activeElement === searchInput && searchInput?.value) {
      searchInput.value = '';
      applyNoteFilters();
    }
  });
})();
