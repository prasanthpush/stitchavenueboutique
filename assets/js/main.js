/* Stitch Avenue Boutique — homepage behaviour */
(function () {
  'use strict';

  /* ---- Mobile navigation ---- */
  var burger = document.getElementById('burger');
  var nav = document.getElementById('nav');

  function closeNav() {
    nav.classList.remove('is-open');
    burger.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('nav-open');
  }

  burger.addEventListener('click', function () {
    var open = nav.classList.toggle('is-open');
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    document.body.classList.toggle('nav-open', open);
  });

  nav.addEventListener('click', function (e) {
    if (e.target.closest('a')) closeNav();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeNav();
  });

  /* ---- Header shadow once scrolled ---- */
  var header = document.getElementById('header');
  var onScroll = function () {
    header.classList.toggle('is-stuck', window.scrollY > 8);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---- Reveal elements as they enter the viewport ---- */
  var revealables = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        io.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px' });

    revealables.forEach(function (el, i) {
      el.style.transitionDelay = (i % 4) * 70 + 'ms';
      io.observe(el);
    });
  } else {
    revealables.forEach(function (el) { el.classList.add('is-visible'); });
  }

  /* ---- Highlight the section currently in view ---- */
  var links = Array.prototype.slice.call(document.querySelectorAll('.nav__link'));
  var sections = links
    .map(function (a) { return document.querySelector(a.getAttribute('href')); })
    .filter(Boolean);

  if ('IntersectionObserver' in window && sections.length) {
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        links.forEach(function (a) {
          a.classList.toggle('is-active', a.getAttribute('href') === '#' + entry.target.id);
        });
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    sections.forEach(function (s) { spy.observe(s); });
  }

  /* ---- Booking form (client-side only for now) ---- */
  var form = document.getElementById('bookingForm');
  var note = document.getElementById('formNote');

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    // form.elements — form.name would resolve to the form's own name property
    var name = form.elements.name;
    var phone = form.elements.phone;
    var problems = [];

    [name, phone].forEach(function (f) { f.classList.remove('is-error'); });

    if (!name.value.trim()) { name.classList.add('is-error'); problems.push('name'); }
    if (!/^[0-9+\s-]{10,15}$/.test(phone.value.trim())) { phone.classList.add('is-error'); problems.push('phone'); }

    if (problems.length) {
      note.textContent = 'Please check your ' + problems.join(' and ') + '.';
      note.className = 'form__note is-bad';
      (problems[0] === 'name' ? name : phone).focus();
      return;
    }

    // TODO: replace with a fetch() to book.php once the backend handler exists.
    note.textContent = 'Thank you, ' + name.value.trim().split(' ')[0] + '. We will call you to confirm your slot.';
    note.className = 'form__note is-ok';
    form.reset();
  });

  /* ---- Footer year ---- */
  document.getElementById('year').textContent = new Date().getFullYear();
})();
