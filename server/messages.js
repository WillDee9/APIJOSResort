'use strict';
// Wording of every message guests and staff receive. Pure functions, so they are easy to test.
const { nightsBetween } = require('./logic');

// Turns local or international numbers into the form SMS providers expect, such as 233241234567.
function toMsisdn(phone) {
  const raw = String(phone || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+') || digits.startsWith('00')) {
    const d = digits.replace(/^00/, '');
    return d.length >= 8 && d.length <= 15 && !d.startsWith('0') ? d : null;
  }
  if (/^0\d{9}$/.test(digits)) return `233${digits.slice(1)}`;
  if (/^233\d{9}$/.test(digits)) return digits;
  return null;
}

// The cedi sign and other special characters shrink a text to 70 characters and raise its cost.
function smsSafe(text) {
  const plain = String(text).replace(/GH₵/g, 'GHS').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7e\n]/g, '?').replace(/\s+/g, ' ').trim();
  return plain.length > 160 ? `${plain.slice(0, 157)}...` : plain;
}
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const niceDate = s => new Date(`${s}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const money = (p, cur) => `${cur} ${(p / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const refOf = r => `APJ-${String(r.id).slice(0, 6).toUpperCase()}`;

function emailHtml(ctx, heading, paragraphs, button) {
  const p = paragraphs.filter(Boolean).map(t => `<p style="margin:0 0 14px;line-height:1.5">${esc(t)}</p>`).join('');
  const b = button ? `<p style="margin:20px 0"><a href="${esc(button.url)}" style="background:#0a6464;color:#ffffff;padding:11px 18px;border-radius:7px;text-decoration:none;font-weight:bold;display:inline-block">${esc(button.label)}</a></p>` : '';
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#0e2e2d;max-width:560px;margin:0 auto;padding:8px"><div style="background:#084f50;color:#ffffff;padding:16px 18px;border-radius:8px 8px 0 0"><b style="letter-spacing:1px">${esc(ctx.resort)}</b><br><span style="color:#f2b632">${esc(ctx.slogan)}</span></div><div style="border:1px solid #c9dcd8;border-top:0;padding:18px;border-radius:0 0 8px 8px"><h2 style="margin:0 0 14px;font-size:20px">${esc(heading)}</h2>${p}${b}</div></div>`;
}
function emailText(ctx, heading, paragraphs, button) {
  return [heading, '', ...paragraphs.filter(Boolean).flatMap(t => [t, '']), ...(button ? [`${button.label}: ${button.url}`, ''] : []), `${ctx.resort}: ${ctx.slogan}`].join('\n');
}
function build(ctx, heading, paragraphs, button, sms) {
  return { subject: `${heading} | ${ctx.resort}`, text: emailText(ctx, heading, paragraphs, button), html: emailHtml(ctx, heading, paragraphs, button), sms: sms ? smsSafe(sms) : null };
}

function describe(r, unitName) {
  if (r.type === 'stay') { const n = nightsBetween(r.check_in, r.check_out); return { long: `${r.room_name} at ${unitName}, ${niceDate(r.check_in)} to ${niceDate(r.check_out)} (${n} night${n === 1 ? '' : 's'})`, brief: `${String(r.room_name).slice(0, 22)} ${niceDate(r.check_in)}-${niceDate(r.check_out)}`, word: 'booking' }; }
  if (r.type === 'pool') return { long: `Pool pass for ${niceDate(r.pool_date)}: ${r.adults} adults, ${r.kids} children`, brief: `Pool pass ${niceDate(r.pool_date)}`, word: 'pool pass' };
  const lines = JSON.parse(r.lines || '[]');
  return { long: `${lines.map(l => `${l.qty} x ${l.name}`).join(', ')} from ${unitName}, to ${r.deliver_to}`, brief: `Order from ${String(unitName).slice(0, 22)}`, word: 'order' };
}

// event: received, paid, confirmed, accepted, declined, cancelled, desk_paid, review, reminder
function bookingMessage(event, r, unitName, ctx) {
  const d = describe(r, unitName); const ref = refOf(r); const amount = money(r.total, ctx.currency);
  const call = ctx.phone ? ` Call ${ctx.phone}.` : '';
  const account = { label: 'See my bookings', url: `${ctx.appUrl}/` };
  const hello = `Hello ${r.guest_name},`;
  const refLine = `Reference: ${ref}`;
  switch (event) {
    case 'received': return build(ctx, 'We received your request', [hello, `We have your ${d.word}: ${d.long}.`, `Total: ${amount}, payable at the resort. The front desk will confirm it shortly.`, refLine], account, null);
    case 'paid': return r.type === 'order'
      ? build(ctx, 'Payment received. Your order is being prepared', [hello, d.long, `Paid: ${amount}.`, refLine], account, `${ctx.resort}: Payment of ${money(r.total, ctx.currency)} received. Your order is being prepared. Ref ${ref}.`)
      : build(ctx, `Your ${d.word} is confirmed`, [hello, `Thank you. We received your payment of ${amount}.`, d.long, refLine, ctx.policy], account, `${ctx.resort}: ${d.brief} confirmed. Paid ${money(r.total, ctx.currency)}. Ref ${ref}.${call}`);
    case 'confirmed': return build(ctx, `Your ${d.word} is confirmed`, [hello, d.long, r.paid ? `Paid: ${amount}.` : `Total: ${amount}, payable at the resort.`, refLine, ctx.policy], account, `${ctx.resort}: ${d.brief} confirmed. ${r.paid ? 'Paid' : 'Due'} ${money(r.total, ctx.currency)}. Ref ${ref}.${call}`);
    case 'accepted': return build(ctx, 'Your order is being prepared', [hello, d.long, `Total: ${amount}.`, refLine], account, null);
    case 'declined': return build(ctx, `We could not accept your ${d.word}`, [hello, `We are sorry. We could not accept this ${d.word}: ${d.long}.`, ctx.phone ? `Please call us on ${ctx.phone} and we will try to help.` : 'Please contact the front desk and we will try to help.', refLine], account, `${ctx.resort}: Sorry, we could not accept your ${d.word} (${d.brief}). Ref ${ref}.${call}`);
    case 'cancelled': return build(ctx, `Your ${d.word} was cancelled`, [hello, `This ${d.word} has been cancelled: ${d.long}.`, r.paid ? `Your payment of ${amount} is being refunded.` : '', refLine], account, `${ctx.resort}: Your ${d.word} (${d.brief}) was cancelled.${r.paid ? ' Your refund is being processed.' : ''} Ref ${ref}.${call}`);
    case 'desk_paid': return build(ctx, 'Payment receipt', [hello, `We received ${amount} by ${r.paid_method}.`, d.long, refLine, 'Thank you for choosing us.'], null, null);
    case 'review': return build(ctx, 'We received your payment and are checking it', [hello, `We received a payment for your ${d.word}, and a member of staff needs to check it: ${d.long}.`, ctx.phone ? `We will contact you soon. You can also call us on ${ctx.phone}.` : 'We will contact you soon.', refLine], account, `${ctx.resort}: We received your payment and staff are checking your ${d.word}. We will contact you soon. Ref ${ref}.${call}`);
    case 'reminder': return build(ctx, 'We look forward to seeing you tomorrow', [hello, `Your stay begins tomorrow: ${d.long}.`, r.paid ? 'Your stay is fully paid.' : `Amount due at the resort: ${amount}.`, refLine], account, `${ctx.resort}: See you tomorrow! ${d.brief}. ${r.paid ? 'Fully paid.' : `Due ${money(r.total, ctx.currency)}.`} Ref ${ref}.${call}`);
    default: throw new Error(`Unknown message: ${event}`);
  }
}
const resetMessage = (ctx, name, url) => build(ctx, 'Reset your password', [`Hello ${name},`, 'Use the button below to choose a new password. It works once and ends in 1 hour.', 'If you did not ask for this, ignore this email. Your password stays the same.'], { label: 'Choose a new password', url }, null);
const inviteMessage = (ctx, name, url) => build(ctx, 'Your staff account is ready', [`Hello ${name},`, 'Use the button below to choose your password. It works once and ends in 24 hours.'], { label: 'Choose my password', url }, null);
const passwordChanged = (ctx, name) => build(ctx, 'Your password was changed', [`Hello ${name},`, `Your password has just been changed. If this wasn't you, contact the resort straight away${ctx.phone ? ` on ${ctx.phone}` : ''}.`], null, null);
const deskAlert = (ctx, heading, lines, sms) => build(ctx, heading, lines, { label: 'Open the portal', url: `${ctx.appUrl}/portal` }, sms);

module.exports = { toMsisdn, smsSafe, refOf, bookingMessage, resetMessage, inviteMessage, passwordChanged, deskAlert, money, describe };
