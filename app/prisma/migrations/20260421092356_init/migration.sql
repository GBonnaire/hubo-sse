-- CreateTable
CREATE TABLE `tenants` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `app_id` VARCHAR(100) NOT NULL,
    `secret` TEXT NOT NULL,
    `algorithm` VARCHAR(10) NOT NULL DEFAULT 'HS256',
    `public_key` TEXT NULL,
    `origins` JSON NOT NULL,
    `stream_ttl` INTEGER NOT NULL DEFAULT 3600,
    `max_stream_length` INTEGER NOT NULL DEFAULT 10000,
    `rate_limit_publish` INTEGER NOT NULL DEFAULT 100,
    `rate_limit_connections` INTEGER NOT NULL DEFAULT 500,
    `max_event_size` INTEGER NOT NULL DEFAULT 65536,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `tenants_app_id_key`(`app_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
