ALTER TABLE inventory_transactions ADD reserved_after numeric(20,6) NOT NULL DEFAULT 0 CHECK(reserved_after>=0);
