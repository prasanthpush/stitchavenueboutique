/* Stitch Avenue Boutique — homepage behaviour */
(function () {
  'use strict';

  /* ---- Mobile navigation ---- */
  var burger = document.getElementById('burger');
  var nav = document.getElementById('nav');
  var scrim = document.getElementById('navScrim');

  /* One place that owns the open/closed state, so the burger, the scrim, the
     links and Escape can never disagree about it. */
  function setNav(open) {
    nav.classList.toggle('is-open', open);
    if (scrim) scrim.classList.toggle('is-shown', open);
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    document.body.classList.toggle('nav-open', open);
  }

  function closeNav() { setNav(false); }

  burger.addEventListener('click', function () {
    setNav(!nav.classList.contains('is-open'));
  });

  if (scrim) scrim.addEventListener('click', closeNav);

  nav.addEventListener('click', function (e) {
    if (e.target.closest('a')) closeNav();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeNav();
  });

  // Rotating to landscape can cross the breakpoint with the drawer still open,
  // which would leave the desktop nav stuck in its open state.
  window.addEventListener('resize', function () {
    if (window.innerWidth > 820 && nav.classList.contains('is-open')) closeNav();
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

  /* ---- Booking form ----------------------------------------------------
     The server is the authority on every rule below; this is here so the
     customer finds out about a typo before a round trip, not instead of one. */
  var form   = document.getElementById('bookingForm');
  var note   = document.getElementById('formNote');
  var submit = document.getElementById('bookingSubmit');
  var tokenField = document.getElementById('formToken');

  var PHONE_HELP = 'Enter a 10-digit Indian mobile number.';
  var FIELDS = ['name', 'phone', 'email', 'date', 'service', 'notes'];

  /* Letters, accents and Indic vowel signs, plus the punctuation real names
     use. Unicode property escapes need ES2018 — on anything older, fall back
     to "no digits" and let the server make the real decision. */
  var NAME_RE;
  try {
    NAME_RE = new RegExp('^[\\p{L}\\p{M}][\\p{L}\\p{M} .\'-]*$', 'u');
  } catch (err) {
    NAME_RE = /^[^\d]+$/;
  }

  /* -- Single-use token. Fetched on load; its issue time is also the clock
        the server uses to reject submissions filled in inhumanly fast. -- */
  var tokenPending = null;

  function loadToken() {
    tokenPending = fetch('/api/form-token', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' }
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        tokenField.value = (data && data.token) || '';
        return tokenField.value;
      })
      .catch(function () {
        tokenField.value = '';
        return '';
      });
    return tokenPending;
  }
  loadToken();

  /* -- Field-level messaging -- */
  function clearErrors() {
    FIELDS.forEach(function (name) {
      var input = form.elements[name];
      var slot  = document.getElementById('err-' + name);
      if (input) input.classList.remove('is-error');
      if (slot) { slot.textContent = ''; slot.classList.remove('is-shown'); }
    });
  }

  function showErrors(errors) {
    var first = null;
    Object.keys(errors).forEach(function (name) {
      var input = form.elements[name];
      var slot  = document.getElementById('err-' + name);
      if (input) input.classList.add('is-error');
      if (slot) { slot.textContent = errors[name]; slot.classList.add('is-shown'); }
      if (!first && input) first = input;
    });
    if (first) first.focus();
  }

  function setNote(text, state) {
    note.textContent = text;
    note.className = 'form__note' + (state ? ' is-' + state : '');
  }

  /* -- Mirrors app/Validator.php. Keep the two in step. -- */
  function validate() {
    var errors = {};
    var v = function (name) {
      var el = form.elements[name];
      return el ? el.value.trim() : '';
    };

    var name = v('name').replace(/\s+/g, ' ');
    if (!name) {
      errors.name = 'Please tell us your name.';
    } else if (name.length < 2) {
      errors.name = 'That name looks too short.';
    } else if (!NAME_RE.test(name)) {
      errors.name = 'Please use letters only — no digits, links or symbols.';
    }

    var digits = v('phone').replace(/[^\d]/g, '').replace(/^(?:91|0)(?=\d{10}$)/, '');
    if (!digits) {
      errors.phone = 'Please give us a phone number.';
    } else if (!/^[6-9]\d{9}$/.test(digits)) {
      errors.phone = PHONE_HELP;
    }

    var email = v('email');
    if (!email) {
      errors.email = 'Please give us an email address.';
    } else if (email.length > 100 || !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) {
      errors.email = 'That email address does not look right.';
    }

    var date = v('date');
    if (date) {
      var picked = new Date(date + 'T00:00:00');
      var today  = new Date();
      today.setHours(0, 0, 0, 0);
      var limit = new Date(today);
      limit.setDate(limit.getDate() + 180);

      if (isNaN(picked.getTime())) {
        errors.date = 'Please pick a valid date.';
      } else if (picked < today) {
        errors.date = 'Please pick a date that has not passed.';
      } else if (picked > limit) {
        errors.date = 'Please pick a date within the next six months.';
      }
    }

    if (v('notes').length > 700) {
      errors.notes = 'Please keep this under 700 characters.';
    }

    return errors;
  }

  function busy(on) {
    submit.disabled = on;
    submit.classList.toggle('is-busy', on);
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (submit.disabled) return;

    clearErrors();

    var errors = validate();
    if (Object.keys(errors).length) {
      showErrors(errors);
      setNote('Please check the highlighted fields.', 'bad');
      return;
    }

    busy(true);
    setNote('Sending…', '');

    // The token request may still be in flight on a very fast fill.
    Promise.resolve(tokenPending)
      .then(function () {
        return fetch(form.getAttribute('action'), {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Accept': 'application/json'
          },
          body: new URLSearchParams(new FormData(form)).toString()
        });
      })
      .then(function (response) {
        return response.json()
          .catch(function () { return { ok: false, message: '' }; })
          .then(function (data) { return { status: response.status, data: data }; });
      })
      .then(function (result) {
        var data = result.data || {};

        if (data.ok) {
          form.reset();
          clearErrors();
          setNote(data.message || 'Thank you. We will call you shortly.', 'ok');
          loadToken();          // the old token has just been burned
          return;
        }

        if (data.errors) showErrors(data.errors);
        setNote(
          data.message || 'We could not send that. Please call us on +91 70949 51438.',
          'bad'
        );

        // A stale or spent token only recovers with a fresh one.
        if (result.status === 409 || result.status === 403) loadToken();
      })
      .catch(function () {
        setNote(
          'We could not reach the server. Please check your connection, or call +91 70949 51438.',
          'bad'
        );
      })
      .then(function () { busy(false); });
  });

  // Clear a field's error as soon as the customer starts fixing it.
  form.addEventListener('input', function (e) {
    var field = e.target;
    if (!field.name || !field.classList.contains('is-error')) return;
    field.classList.remove('is-error');
    var slot = document.getElementById('err-' + field.name);
    if (slot) { slot.textContent = ''; slot.classList.remove('is-shown'); }
  });

  // The date picker cannot offer a day that has already gone.
  var dateInput = form.elements.date;
  if (dateInput) {
    var today = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var iso = function (d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
    var max = new Date(today);
    max.setDate(max.getDate() + 180);
    dateInput.min = iso(today);
    dateInput.max = iso(max);
  }

  /* ---- Footer year ---- */
  document.getElementById('year').textContent = new Date().getFullYear();
})();
