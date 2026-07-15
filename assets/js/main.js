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
})();
