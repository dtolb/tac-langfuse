<script>
  function panelFor(el) {
    return document.getElementById(el.getAttribute('aria-controls'));
  }

  function toggleStep(row, force) {
    var step = row.closest('.step');
    var panel = panelFor(row);
    if (!panel) return;
    var open = (force === undefined) ? row.getAttribute('aria-expanded') !== 'true' : force;
    row.setAttribute('aria-expanded', String(open));
    step.classList.toggle('open', open);
    panel.hidden = !open;
  }

  // One node panel open at a time: the panels are long enough that two open at once
  // pushes the diagram off screen.
  function toggleNode(node) {
    var wasOpen = node.getAttribute('aria-expanded') === 'true';
    document.querySelectorAll('.node').forEach(function (n) {
      n.setAttribute('aria-expanded', 'false');
      n.classList.remove('sel');
    });
    document.querySelectorAll('.node-detail').forEach(function (d) { d.hidden = true; });
    if (!wasOpen) {
      node.setAttribute('aria-expanded', 'true');
      node.classList.add('sel');
      var panel = panelFor(node);
      if (panel) panel.hidden = false;
    }
  }

  document.addEventListener('click', function (e) {
    var bulk = e.target.closest('[data-bulk]');
    if (bulk) {
      var scope = document.querySelector(bulk.getAttribute('data-scope'));
      var open = bulk.getAttribute('data-bulk') === 'open';
      scope.querySelectorAll('.row').forEach(function (r) { toggleStep(r, open); });
      return;
    }
    var row = e.target.closest('.row');
    if (row) { toggleStep(row); return; }
    var node = e.target.closest('.node');
    if (node) { toggleNode(node); }
  });

  document.querySelectorAll('.node').forEach(function (n) {
    n.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        toggleNode(n);
      }
    });
  });

  // Deep link to a hop: works on load and on a hash pasted into an open page.
  function openFromHash(scroll) {
    if (!window.location.hash) return;
    var target;
    try { target = document.querySelector(window.location.hash); } catch (err) { return; }
    if (!target || !target.classList.contains('step')) return;
    toggleStep(target.querySelector('.row'), true);
    if (scroll) target.scrollIntoView({ block: 'center' });
  }

  window.addEventListener('hashchange', function () { openFromHash(true); });
  openFromHash(true);
</script>
</body>
</html>
