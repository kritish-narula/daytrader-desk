/* Self-learning screen + the "track record at this score" line on the stock page. */
function calibLine(h) {
  const c = h && h.calib; if (!c) return '';
  const days = { swing: 10, short: 30, medium: 120 }[Object.keys(Engine.HORIZONS).find(k => Engine.HORIZONS[k].label === h.label)] || '';
  const good = c.p >= c.be + 3 && c.ret > 0, bad = c.p < c.be || c.ret <= 0;
  return `<div class="calib ${good ? 'g' : bad ? 'b' : ''}"><div class="ch">📊 Track record at this strength <span class="mu">(score ${c.lo}–${Math.min(100, c.hi - 1)})</span></div>
   <div class="cb"><span><b>${c.p}%</b> hit Target 1 first</span><span><b class="${c.ret >= 0 ? 'up' : 'dn'}">${c.ret >= 0 ? '+' : ''}${c.ret}%</b> avg in ${days} days</span><span>break-even ${c.be}%</span></div>
   <div class="note">${c.n.toLocaleString()} past signals across 80 stocks${c.live ? ` · your phone: ${c.liveHit}% of ${c.live}` : ''}. ${good ? 'This band has paid in the past.' : bad ? 'This band has not beaten break-even — size down or skip.' : 'Marginal edge.'}</div></div>`;
}
function vAI() {
  const R = Learn.report(), M = R.model || {}, hzs = ['swing', 'short', 'medium'], L = { swing: 'Swing', short: 'Short', medium: 'Medium' };
  const sel = S.aiHz || 'swing', bins = (M.calib || {})[sel] || [], loc = (Engine.LOCAL.calib || {})[sel] || [];
  const pct = x => x == null ? '–' : x + '%', ago = t => { const d = (Date.now() - t) / 864e5; return d < 1 ? 'today' : Math.round(d) + 'd ago'; };
  const met = M.metrics || {}, by = R.by[sel] || {};
  const pretty = k => `<span class="mu">${L[k.split(':')[0]] || ''}</span> ${esc(Engine.label(k))}`;
  $('#view').innerHTML = `<div class="dh"><button class="back" id="back">←</button><div class="t"><div class="s">🧠 Self-learning</div><div class="f">The app grades its own calls and re-tunes itself</div></div></div>
  <div class="card ai-hero"><div class="ai-v">Model v${M.v || 0}</div><div class="note">${M.v ? `Trained ${esc(M.date)} on ${M.trainedOn ? M.trainedOn.stocks + ' stocks · ' + M.trainedOn.samples.toLocaleString() + ' past situations' : ''} · ${R.src === 'downloaded' ? 'downloaded update' : 'built into this app'}` : 'No trained model yet: it is built on the next app build'}</div>
   <div class="ai-hz">${hzs.map(h => { const m = met[h]; return m ? `<div><span>${L[h]}</span><b class="${m.adopted ? 'up' : ''}">${m.adopted ? 'Improved' : 'Kept'}</b><small>${m.adopted ? `+${((m.testNew - m.test) * 100).toFixed(1)} pts on unseen stocks` : 'no better weights found'}</small></div>` : ''; }).join('')}</div>
   <div class="srow" style="margin-top:10px"><div><b>Learn on this phone</b><div class="note">Grade every rating you see and fine-tune from real outcomes</div></div><input type="checkbox" class="tg" id="aiOn" ${R.on ? 'checked' : ''}></div></div>
  <h3>How it improves</h3><div class="card note ai-how">
   <div>1 · <b>Every Sunday</b> it replays 5 years of 80 NSE stocks, re-tunes each factor's weight and re-measures every score band and setup.</div>
   <div>2 · <b>Champion vs challenger:</b> new weights go live only if they predict better on 40 stocks they were not tuned on. Otherwise the old model stays.</div>
   <div>3 · <b>On your phone</b> every rating is logged and graded when the horizon ends: did it hit Target 1 before the stop?</div>
   <div>4 · Your results refine the score bands (win-rate per score). Weight nudges from your phone are tracked and shown below but not applied, so the list and the stock page always score the same way; weights are retrained on GitHub.</div></div>
  <h3>Score bands → what actually happened</h3>
  <div class="chips" id="aiHz">${hzs.map(h => `<button class="chip ${h === sel ? 'on' : ''}" data-h="${h}">${L[h]}</button>`).join('')}</div>
  <div class="card"><table class="ai-t"><tr><th>Score</th><th>Hit T1</th><th>Avg return</th><th>Signals</th><th>Your phone</th></tr>
   ${bins.length ? bins.slice().reverse().map(b => { const k = Engine.binOf(b.lo), l = loc[k] || {}, ln = (l.w || 0) + (l.l || 0), be = Math.round(100 / (1 + Engine.HORIZONS[sel].t1)), p = Math.round(b.p * 100);
     return `<tr><td><b>${b.lo}–${Math.min(100, b.hi - 1)}</b></td><td class="${p >= be + 3 ? 'up' : p < be ? 'dn' : ''}">${p}%</td><td class="${b.ret >= 0 ? 'up' : 'dn'}">${b.ret >= 0 ? '+' : ''}${b.ret}%</td><td>${b.n.toLocaleString()}</td><td>${ln ? Math.round(100 * l.w / ln) + '% of ' + ln : '–'}</td></tr>`; }).join('') : '<tr><td colspan="5" class="note">Appears after the first trained build.</td></tr>'}
  </table><div class="note">Hit T1 = price reached Target 1 before the stop within ${Engine.HORIZONS[sel].dur}. Break-even is ${Math.round(100 / (1 + Engine.HORIZONS[sel].t1))}% (green = beat it). The app shows this track record on every stock page.</div></div>
  <h3>Your phone's track record</h3><div class="card"><div class="ai-g">
   <div><span>Logged</span><b>${R.total}</b></div><div><span>Waiting</span><b>${R.pending}</b></div><div><span>Graded</span><b>${R.resolved}</b></div>
   <div><span>${L[sel]} BUY calls hit</span><b>${pct(by.buyHit)}</b><small>${by.buyN || 0} graded</small></div><div><span>Other calls hit</span><b>${pct(by.waitHit)}</b></div>
   <div><span>Forecast error</span><b class="${by.brier != null && by.brier < by.naive ? 'up' : ''}">${by.brier == null ? '–' : by.brier.toFixed(3)}</b><small>${by.naive == null ? 'lower is better' : 'guessing: ' + by.naive.toFixed(3)}</small></div></div>
   <div class="note">Swing calls are graded after 10 trading days, short after 30, medium after 120. Fine-tuning starts after 60 graded calls per horizon.</div>
   <div class="srow"><button class="btn sm" id="aiNow">Grade pending now</button><button class="btn sm g" id="aiReset">Reset phone learning</button></div></div>
  <h3>What it changed</h3><div class="card">${R.tuned.length ? R.tuned.slice(0, 14).map(([k, m]) => `<div class="ai-w"><div>${pretty(k)}</div><b class="${m > 1 ? 'up' : 'dn'}">${m === 0 ? 'off' : '×' + m.toFixed(2)}</b></div>`).join('') + '<div class="note">×1.5 = counts 50% more in the rating; off = found useless, ignored.</div>' : '<div class="note">No weight changes yet: every factor still at its starting weight.</div>'}</div>
  <h3>Learning log</h3><div class="card">${[...R.rounds.map(r => ({ t: ago(r.at), h: r.hz === 'all' ? 'All' : L[r.hz], w: r.what, d: `${r.before} → ${r.after} on ${r.n} calls` })), ...((M.history || []).slice().reverse().map(x => ({ t: x.date, h: 'Weekly v' + x.v, w: Object.values(x.metrics || {}).some(m => m.adopted) ? 'adopted' : 'kept', d: x.samples.toLocaleString() + ' situations' })))].slice(0, 20).map(x => `<div class="ai-l"><span class="mu">${esc(x.t)}</span><b>${esc(x.h)}</b><span class="tag ${x.w === 'adopted' ? 'p' : x.w === 'rolled back' ? 'n' : ''}">${esc(x.w)}</span><small>${esc(x.d)}</small></div>`).join('') || '<div class="note">Nothing yet.</div>'}</div>
  <div class="note" style="padding:0 4px 20px">Past hit rates are measured, not promised. Markets change; that is why it keeps re-measuring.</div>`;
  $('#back').onclick = back;
  $('#aiOn').onchange = e => { Learn.setOn(e.target.checked); vAI(); };
  document.querySelectorAll('#aiHz .chip').forEach(b => b.onclick = () => { S.aiHz = b.dataset.h; vAI(); });
  $('#aiNow').onclick = async e => { e.target.textContent = 'Checking…'; e.target.disabled = true; const n = await Learn.tick(learnFetch, true); toast(n ? `Graded ${n} calls` : 'Nothing ready to grade yet'); vAI(); };
  $('#aiReset').onclick = () => { if (confirm('Forget everything this phone learned? (The weekly model stays.)')) { Learn.reset(); vAI(); } };
}
