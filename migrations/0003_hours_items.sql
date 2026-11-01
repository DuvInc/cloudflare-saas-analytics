-- Hour by hour (UTC) of each day: {"views": [24], "visits": [24]}; and what a payment bought.
ALTER TABLE days ADD COLUMN hourly TEXT;
ALTER TABLE payments ADD COLUMN item TEXT;
