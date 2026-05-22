-- VirtualDJ linked tracks export
-- Apply with: sqlite3 /path/to/extra.db < linked-tracks-export.sql
-- VirtualDJ must NOT be running while you do this.
BEGIN TRANSACTION;
INSERT OR IGNORE INTO track_data (sid, file, artist, title, remix) VALUES (-1837539717664274700, 'netsearch://sc501298839', 'Lil Uzi Vert', 'New Patek', NULL);
INSERT OR IGNORE INTO track_data (sid, file, artist, title, remix) VALUES (6228976102159244000, 'netsearch://sc317417947', 'Gucci Mane', 'On Deck', NULL);
INSERT INTO related_tracks (sid1, sid2) SELECT -1837539717664274700, 6228976102159244000 WHERE NOT EXISTS (SELECT 1 FROM related_tracks WHERE (sid1 = -1837539717664274700 AND sid2 = 6228976102159244000) OR (sid1 = 6228976102159244000 AND sid2 = -1837539717664274700));
COMMIT;
