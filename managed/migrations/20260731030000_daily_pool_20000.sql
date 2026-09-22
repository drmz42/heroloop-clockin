UPDATE token_pool
SET pool_amount = 20000,
    distribution_rate = 1,
    updated_at = now()
WHERE id = 1;
