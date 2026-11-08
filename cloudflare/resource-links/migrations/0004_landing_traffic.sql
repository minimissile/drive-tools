-- Anonymous daily counters: no cookies, visitor IDs, IPs, raw URLs or drive credentials.
CREATE TABLE landing_traffic_meta (
  id INTEGER PRIMARY KEY CHECK (id=1),
  tracking_since TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO landing_traffic_meta(id) VALUES(1);
CREATE TABLE landing_traffic_daily (
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  channel TEXT NOT NULL,
  kind TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0 CHECK(events>=0),
  PRIMARY KEY(day,path,channel,kind)
) WITHOUT ROWID;
CREATE INDEX landing_traffic_path_day ON landing_traffic_daily(path,day);
