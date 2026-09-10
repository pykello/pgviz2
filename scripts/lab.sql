-- Run only in a scratch database. No existing objects are replaced.
CREATE EXTENSION IF NOT EXISTS pageinspect;
CREATE SCHEMA pgviz_lab;
CREATE TABLE pgviz_lab.orders (id integer PRIMARY KEY, customer_id integer, note text) WITH (fillfactor=75);
INSERT INTO pgviz_lab.orders SELECT i, i % 400, repeat('order ' || i || ' ', 8) FROM generate_series(1, 50000) i;
CREATE INDEX orders_customer_idx ON pgviz_lab.orders(customer_id);
CREATE INDEX orders_note_idx ON pgviz_lab.orders(note);
CREATE TABLE pgviz_lab.small (id integer, note text);
INSERT INTO pgviz_lab.small VALUES (-10, 'negative'), (0, NULL), (42, 'answer');
CREATE INDEX small_idx ON pgviz_lab.small(id);
CREATE TABLE pgviz_lab.empty (id integer);
CREATE INDEX empty_idx ON pgviz_lab.empty(id);
UPDATE pgviz_lab.orders SET note = 'updated' WHERE id BETWEEN 10 AND 20;
ANALYZE pgviz_lab.orders;
