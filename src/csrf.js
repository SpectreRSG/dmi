// Protection against "cross-site request forgery" (CSRF).
//
// Every form on the site includes a secret token. When a form is submitted we
// check the token matches. A malicious website can't know the token, so it
// can't trick a logged-in manager's browser into submitting our forms.
const crypto = require('crypto');

function sameToken(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function csrfProtection(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;

  if (req.method === 'GET' || req.method === 'HEAD') return next();

  const sent = req.body?._csrf;
  if (sent && sameToken(sent, req.session.csrfToken)) return next();

  res.status(403).render('error', {
    title: 'Form expired',
    message: 'This form expired or was sent from somewhere else. Go back, refresh the page and try again.',
  });
}

module.exports = csrfProtection;
