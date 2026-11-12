# Supabase-functies van Nota

Deze code draait in Supabase (project Nota), niet in de browser.

- `functions/push`: herinneringen en ochtendoverzicht als pushmelding.
  Wordt elke minuut aangeroepen door pg_cron (`nota-herinneringen`).
- `functions/agenda`: agenda-feed (.ics) voor Apple/Google Agenda.

Beide staan op `verify_jwt = false` en controleren zelf de toegang
(cron-geheim, login-token of de geheime agenda-link).

`../server/app.py` is een kopie van de server op de pc
(`Documents/PlatformIO/Projects/XIAO E-ink project/server`). Die pc-versie
is leidend; deze kopie is alleen ter referentie.
