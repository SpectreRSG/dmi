// Activity log: a record of who changed what (admins only).
const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  const entries = db
    .prepare(
      `SELECT a.*, u.name AS user_name FROM activity_log a LEFT JOIN users u ON u.id = a.user_id
       ORDER BY a.id DESC LIMIT 300`
    )
    .all();
  res.render('activity', { title: 'Activity log', entries });
});

module.exports = router;
