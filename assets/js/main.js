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
  const noteCards = [...document.querySelectorAll('.note-row')];
  const resultCount = document.querySelector('#notes-result-count');
  const emptyState = document.querySelector('#notes-empty');
  const clearFilters = document.querySelector('#clear-note-filters');
  const pagination = document.querySelector('#notes-pagination');
  const pageSizeSelect = document.querySelector('#notes-page-size');
  const pageRange = document.querySelector('#notes-page-range');
  const pageControls = document.querySelector('#notes-page-controls');
  const pageNumbers = document.querySelector('#notes-page-numbers');
  const previousPage = document.querySelector('#notes-prev-page');
  const nextPage = document.querySelector('#notes-next-page');
  const allowedPageSizes = ['10', '20', '50', 'all'];
  const savedPageSize = localStorage.getItem('notes-page-size');
  let activeCategory = 'all';
  let currentPage = 1;
  let pageSize = allowedPageSizes.includes(savedPageSize) ? savedPageSize : '20';

  if (pageSizeSelect) pageSizeSelect.value = pageSize;

  const normalize = value => value.trim().toLocaleLowerCase('zh-CN');

  const getPageItems = totalPages => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);
    if (currentPage <= 4) return [1, 2, 3, 4, 5, 'ellipsis', totalPages];
    if (currentPage >= totalPages - 3) return [1, 'ellipsis', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
    return [1, 'ellipsis', currentPage - 1, currentPage, currentPage + 1, 'ellipsis', totalPages];
  };

  const renderPageNumbers = totalPages => {
    if (!pageNumbers) return;
    pageNumbers.replaceChildren();

    getPageItems(totalPages).forEach(item => {
      if (item === 'ellipsis') {
        const separator = document.createElement('span');
        separator.className = 'page-ellipsis';
        separator.textContent = '…';
        pageNumbers.append(separator);
        return;
      }

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'page-number';
      button.textContent = item;
      button.setAttribute('aria-label', `第 ${item} 页`);
      if (item === currentPage) {
        button.classList.add('active');
        button.setAttribute('aria-current', 'page');
      }
      button.addEventListener('click', () => {
        currentPage = item;
        applyNoteFilters();
        document.querySelector('#articles')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      pageNumbers.append(button);
    });
  };

  const applyNoteFilters = (resetPage = false) => {
    if (resetPage) currentPage = 1;
    const query = normalize(searchInput?.value || '');
    const filteredCards = noteCards.filter(card => {
      const matchesCategory = activeCategory === 'all' || card.dataset.category === activeCategory;
      const matchesSearch = !query || normalize(card.dataset.search || '').includes(query);
      return matchesCategory && matchesSearch;
    });

    const numericPageSize = pageSize === 'all' ? Math.max(filteredCards.length, 1) : Number(pageSize);
    const totalPages = Math.max(1, Math.ceil(filteredCards.length / numericPageSize));
    currentPage = Math.min(Math.max(currentPage, 1), totalPages);
    const start = (currentPage - 1) * numericPageSize;
    const end = Math.min(start + numericPageSize, filteredCards.length);
    const visibleCards = new Set(filteredCards.slice(start, end));

    noteCards.forEach(card => { card.hidden = !visibleCards.has(card); });

    if (resultCount) resultCount.textContent = filteredCards.length;
    if (emptyState) emptyState.hidden = filteredCards.length !== 0;
    if (clearFilters) clearFilters.hidden = activeCategory === 'all' && !query;
    if (pagination) pagination.hidden = filteredCards.length === 0;
    if (pageRange) pageRange.textContent = filteredCards.length ? `${start + 1}–${end} / ${filteredCards.length}` : '0 / 0';
    if (pageControls) pageControls.hidden = totalPages <= 1;
    if (previousPage) previousPage.disabled = currentPage <= 1;
    if (nextPage) nextPage.disabled = currentPage >= totalPages;
    renderPageNumbers(totalPages);
  };

  filterButtons.forEach(button => {
    button.addEventListener('click', () => {
      activeCategory = button.dataset.filter || 'all';
      filterButtons.forEach(item => {
        const active = item === button;
        item.classList.toggle('active', active);
        item.setAttribute('aria-pressed', String(active));
      });
      applyNoteFilters(true);
    });
  });

  searchInput?.addEventListener('input', () => applyNoteFilters(true));

  pageSizeSelect?.addEventListener('change', () => {
    pageSize = allowedPageSizes.includes(pageSizeSelect.value) ? pageSizeSelect.value : '20';
    localStorage.setItem('notes-page-size', pageSize);
    applyNoteFilters(true);
  });

  previousPage?.addEventListener('click', () => {
    if (currentPage <= 1) return;
    currentPage -= 1;
    applyNoteFilters();
    document.querySelector('#articles')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  nextPage?.addEventListener('click', () => {
    currentPage += 1;
    applyNoteFilters();
    document.querySelector('#articles')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  clearFilters?.addEventListener('click', () => {
    activeCategory = 'all';
    if (searchInput) searchInput.value = '';
    filterButtons.forEach(button => {
      const active = button.dataset.filter === 'all';
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    applyNoteFilters(true);
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
      applyNoteFilters(true);
    }
  });

  applyNoteFilters();
})();
