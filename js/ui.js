// Мелкие строители DOM: слайдеры, сегменты, переключатели, шторка.

export function el(tag, attrs = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of [].concat(kids)) if (kid) n.appendChild(kid);
  return n;
}

export function icon(path) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.innerHTML = `<path d="${path}"/>`;
  return svg;
}

/** Собирает панель параметров режима. */
export function buildParams(container, params, values, onChange) {
  container.replaceChildren();
  for (const p of params) {
    if (p.type === 'range') {
      const out = el('output', { text: p.fmt ? p.fmt(values[p.key]) : String(values[p.key]) });
      const input = el('input', {
        type: 'range', min: p.min, max: p.max, step: p.step, value: values[p.key],
        'aria-label': p.label,
        oninput: (e) => {
          const v = parseFloat(e.target.value);
          out.textContent = p.fmt ? p.fmt(v) : String(v);
          onChange(p.key, v);
        },
      });
      container.appendChild(el('div', { class: 'ctl' }, [
        el('div', { class: 'ctl-head' }, [el('label', { text: p.label }), out]),
        input,
      ]));
    } else if (p.type === 'seg') {
      const wrap = el('div', { class: 'seg' });
      for (const o of p.options) {
        const b = el('button', {
          class: values[p.key] === o.v ? 'on' : '',
          text: o.label,
          onclick: () => {
            onChange(p.key, o.v);
            [...wrap.children].forEach((c) => c.classList.toggle('on', c === b));
          },
        });
        wrap.appendChild(b);
      }
      container.appendChild(el('div', { class: 'ctl' }, [
        el('div', { class: 'ctl-head' }, [el('label', { text: p.label })]),
        wrap,
      ]));
    } else if (p.type === 'toggle') {
      const btn = el('button', {
        class: 'pill-btn' + (values[p.key] ? ' on' : ''),
        text: p.label,
        onclick: () => {
          const v = values[p.key] ? 0 : 1;
          onChange(p.key, v);
          btn.classList.toggle('on', !!v);
        },
      });
      container.appendChild(el('div', { class: 'actions-row' }, [btn]));
    }
  }
}

export function row(label, sub, control) {
  return el('div', { class: 'row' }, [
    el('div', {}, [el('div', { text: label }), sub ? el('small', { text: sub }) : null]),
    control,
  ]);
}

export function switchBtn(on, onToggle) {
  const b = el('button', { class: 'switch' + (on ? ' on' : ''), role: 'switch', 'aria-checked': on ? 'true' : 'false' });
  b.addEventListener('click', () => {
    const v = !b.classList.contains('on');
    b.classList.toggle('on', v);
    b.setAttribute('aria-checked', v ? 'true' : 'false');
    onToggle(v);
  });
  return b;
}

export function select(options, value, onPick) {
  const s = el('select', { onchange: (e) => onPick(e.target.value) });
  for (const o of options) s.appendChild(el('option', { value: o.value, text: o.label, selected: o.value === value }));
  return s;
}

/** Всплывающая подсказка над кадром. */
export function makeHinter(node) {
  let timer = 0;
  return (text, ms = 3200) => {
    if (!text) return;
    node.textContent = text;
    node.classList.add('show');
    clearTimeout(timer);
    timer = setTimeout(() => node.classList.remove('show'), ms);
  };
}
