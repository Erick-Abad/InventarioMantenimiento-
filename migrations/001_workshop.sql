CREATE TABLE IF NOT EXISTS workshop_control (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  mode ENUM('ADMIN_PRESENTE','AUTOSERVICIO') NOT NULL DEFAULT 'ADMIN_PRESENTE',
  changed_by BIGINT UNSIGNED NULL,
  changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (changed_by) REFERENCES users(id)
);

INSERT INTO workshop_control (id,mode) VALUES (1,'ADMIN_PRESENTE')
ON DUPLICATE KEY UPDATE id=workshop_control.id;

CREATE TABLE IF NOT EXISTS app_sessions (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  last_seen TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at TIMESTAMP NOT NULL,
  ended_at TIMESTAMP(3) NULL,
  INDEX (user_id,ended_at),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS inventory_locations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  module_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  UNIQUE (module_id,name),
  FOREIGN KEY (module_id) REFERENCES modules(id)
);

CREATE TABLE IF NOT EXISTS product_details (
  product_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  location_id BIGINT UNSIGNED NULL,
  brand VARCHAR(160) NULL,
  model VARCHAR(255) NULL,
  measure VARCHAR(120) NULL,
  capacity VARCHAR(255) NULL,
  category VARCHAR(140) NULL,
  specifications TEXT NULL,
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (location_id) REFERENCES inventory_locations(id)
);

CREATE TABLE IF NOT EXISTS tool_locations (
  asset_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  location_id BIGINT UNSIGNED NOT NULL,
  FOREIGN KEY (asset_id) REFERENCES tool_assets(id),
  FOREIGN KEY (location_id) REFERENCES inventory_locations(id)
);
