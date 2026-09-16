(function () {
  const data = window.DASHBOARD_DATA;
  const ruleBody = document.getElementById('rule-body');
  const emptyState = document.getElementById('rule-empty');
  const resultCount = document.getElementById('result-count');
  const search = document.getElementById('rule-search');
  const filters = Array.from(document.querySelectorAll('[data-category]'));
  const tone = { '고정': 'mint', '국내': 'blue', '해외': 'violet', '기타': 'amber' };
  let category = '전체';

  function renderRules() {
    const query = search.value.trim().toLocaleLowerCase('ko-KR');
    const visible = data.rules.filter((rule) => {
      const categoryMatch = category === '전체' || rule[1] === category;
      const queryMatch = !query || rule.join(' ').toLocaleLowerCase('ko-KR').includes(query);
      return categoryMatch && queryMatch;
    });

    ruleBody.textContent = '';
    visible.forEach((rule) => {
      const row = document.createElement('tr');
      row.innerHTML = '<td><span class="rule-id"></span></td><td><span class="category-pill"></span></td><td class="condition-cell"></td><td><span class="folder-target"></span></td><td class="note-cell"></td>';
      row.querySelector('.rule-id').textContent = rule[0];
      const pill = row.querySelector('.category-pill');
      pill.textContent = rule[1];
      pill.classList.add(tone[rule[1]]);
      row.querySelector('.condition-cell').textContent = rule[2];
      row.querySelector('.folder-target').textContent = '▱ ' + rule[3];
      row.querySelector('.note-cell').textContent = rule[4];
      ruleBody.appendChild(row);
    });

    resultCount.textContent = visible.length + ' / ' + data.rules.length;
    emptyState.hidden = visible.length !== 0;
    ruleBody.parentElement.hidden = visible.length === 0;
  }

  search.addEventListener('input', renderRules);
  filters.forEach((button) => button.addEventListener('click', () => {
    category = button.dataset.category;
    filters.forEach((item) => {
      const selected = item === button;
      item.classList.toggle('selected', selected);
      item.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    renderRules();
  }));

  const folderGrid = document.getElementById('folder-grid');
  data.folders.forEach(([name, color, folders]) => {
    const card = document.createElement('article');
    card.className = 'folder-card ' + color;
    const heading = document.createElement('div');
    heading.className = 'folder-card-heading';
    heading.innerHTML = '<div class="folder-stack">▱</div><div><strong></strong><span></span></div>';
    heading.querySelector('strong').textContent = name;
    heading.querySelector('span').textContent = folders.length + '개 폴더';
    const list = document.createElement('ul');
    folders.forEach((folder) => {
      const item = document.createElement('li');
      item.textContent = '› ' + folder;
      list.appendChild(item);
    });
    card.append(heading, list);
    folderGrid.appendChild(card);
  });

  renderRules();
})();
