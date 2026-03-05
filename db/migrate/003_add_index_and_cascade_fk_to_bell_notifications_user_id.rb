class AddIndexAndCascadeFkToBellNotificationsUserId < ActiveRecord::Migration[6.1]
  def up
    unless index_exists?(:bell_notifications, :user_id)
      add_index :bell_notifications, :user_id
    end

    if foreign_key_exists?(:bell_notifications, :users)
      remove_foreign_key :bell_notifications, :users
    end
    add_foreign_key :bell_notifications, :users, column: :user_id, on_delete: :cascade
  end

  def down
    remove_foreign_key :bell_notifications, column: :user_id if foreign_key_exists?(:bell_notifications, :users, column: :user_id)
    remove_index :bell_notifications, :user_id if index_exists?(:bell_notifications, :user_id)
    add_foreign_key :bell_notifications, :users, column: :user_id
  end
end
