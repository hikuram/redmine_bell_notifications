(function() {
  'use strict';

  // Constants - Configuration values used throughout the module
  var CONSTANTS = {
    POLL_INTERVAL_MS: 60000,          // Default polling interval (1 minute)
    RESIZE_DEBOUNCE_MS: 250,          // Window resize debounce delay
    MAX_POLLING_FAILURES: 3,          // Stop polling after this many consecutive failures
    POLLING_RETRY_DELAY_MS: 300000,   // Retry delay after max failures (5 minutes)
    MAX_BADGE_DISPLAY_COUNT: 99,      // Maximum count to show in badge (shows "99+" if more)
    MARK_ALL_FEEDBACK_DURATION_MS: 1500, // Duration to show "Done!" feedback
    CHANNEL_NAME: 'redmine_bell_notifications_sync' // 追加: タブ間通信用のチャンネル名
  };

  var BellNotifications = {
    pollInterval: CONSTANTS.POLL_INTERVAL_MS,
    pollingIntervalId: null, // Store interval ID to prevent memory leaks
    dropdownOpen: false,
    failureCount: 0, // Track consecutive failures
    maxFailures: CONSTANTS.MAX_POLLING_FAILURES,
    backoffMultiplier: 1, // Exponential backoff multiplier
    resizeListenerAdded: false, // Flag to prevent duplicate resize listeners
    mobileMenuSyncAdded: false, // Prevent duplicate mobile menu observers
    mobileMenuObserver: null, // Observe Redmine's responsive flyout state
    originalBellParent: null, // Original hook position before responsive moves
    originalBellNextSibling: null, // Restore point for fallback placement
    channel: null, // 追加: BroadcastChannel用変数
    sessionExpired: false, // 追加: セッション切れフラグ

    getMetaContent: function(name) {
      var meta = document.querySelector('meta[name="' + name + '"]');
      return meta ? meta.getAttribute('content') : '';
    },

    getUnreadCountUrl: function() {
      return this.getMetaContent('bell-notifications-unread-count-url') || '/bell/notifications/unread_count';
    },

    getDropdownUrl: function() {
      return this.getMetaContent('bell-notifications-dropdown-url') || '/bell/notifications/dropdown';
    },

    getMarkAllReadUrl: function() {
      return this.getMetaContent('bell-notifications-mark-all-read-url') || '/bell/notifications/mark_all_read';
    },

    getMarkReadUrl: function(notificationId) {
      var tmpl = this.getMetaContent('bell-notifications-mark-read-url-template');
      if (tmpl && notificationId) {
        return tmpl.replace('__ID__', encodeURIComponent(notificationId));
      }
      return '/bell/notifications/' + encodeURIComponent(notificationId) + '/mark_read';
    },

    isSafeInternalPath: function(url) {
      if (!url) return false;
      if (url === '#' || url === '') return false;
      if (url.indexOf('//') === 0) return false;
      if (url.indexOf('/') !== 0) return false;
      return true;
    },

    init: function() {
      var self = this;

      // Wait for DOM to be ready
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
          self.start();
        });
      } else {
        self.start();
      }
    },

    start: function() {
      this.positionBellIcon();
      this.setupResizeListener();
      this.setupMobileMenuSync();
      this.setupTabSync();           // 追加: タブ同期のセットアップ
      this.setupVisibilityListener();// 追加: タブ表示/非表示の検知
      this.renderBadge();            // 追加: まずDOM上に「待ち受け中」バッジを生成する
      this.updateUnreadCount();
      this.startPolling();
      this.bindEvents();
    },

    positionBellIcon: function() {
      // Position bell icon based on screen size using Redmine's 899px breakpoint
      //
      // Desktop (>899px):
      //   - Moves the icon into #quick-search
      //
      // Mobile (<=899px):
      //   - Moves the icon into Redmine's #header alongside the mobile controls
      //   - Keeps the bell in the same stacking context as the standard header UI

      var bellWrapper = document.getElementById('bell-notifications-wrapper');
      if (!bellWrapper) {
        return;
      }

      // Remember the hook output position before moving the wrapper.
      if (!this.originalBellParent) {
        this.originalBellParent = bellWrapper.parentNode;
        this.originalBellNextSibling = bellWrapper.nextSibling;
      }

      var isMobile = window.innerWidth <= 899;

      if (isMobile) {
        var mobileToggle = document.querySelector(
          '.js-flyout-menu-toggle-button, .mobile-toggle-button'
        );
        var mobileHeader = (
          mobileToggle && mobileToggle.closest('#header, header')
        ) || document.getElementById('header');

        if (mobileHeader) {
          if (bellWrapper.parentNode !== mobileHeader) {
            mobileHeader.appendChild(bellWrapper);
          }
        } else {
          this.restoreBellIconPosition(bellWrapper);
        }
      } else {
        var quickSearch = document.getElementById('quick-search');
        if (quickSearch) {
          if (bellWrapper.parentNode !== quickSearch) {
            quickSearch.appendChild(bellWrapper);
          }
        } else {
          this.restoreBellIconPosition(bellWrapper);
          console.warn('BellNotifications: Could not find quick-search element');
        }
      }
    },

    restoreBellIconPosition: function(bellWrapper) {
      if (!this.originalBellParent) {
        return;
      }

      if (
        this.originalBellNextSibling &&
        this.originalBellNextSibling.parentNode === this.originalBellParent
      ) {
        this.originalBellParent.insertBefore(
          bellWrapper,
          this.originalBellNextSibling
        );
      } else {
        this.originalBellParent.appendChild(bellWrapper);
      }
    },

    setupResizeListener: function() {
      // Set up resize listener only once to prevent memory leaks
      if (this.resizeListenerAdded) {
        return;
      }

      var self = this;
      var resizeTimer;
      window.addEventListener('resize', function() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function() {
          self.positionBellIcon();
          self.applyMobileMenuVisibility();
        }, CONSTANTS.RESIZE_DEBOUNCE_MS);
      });

      this.resizeListenerAdded = true;
    },

    setupMobileMenuSync: function() {
      if (this.mobileMenuSyncAdded) {
        return;
      }

      var self = this;
      var root = document.documentElement;
      if (!root) {
        return;
      }

      this.mobileMenuObserver = new MutationObserver(function() {
        self.applyMobileMenuVisibility();
      });

      this.mobileMenuObserver.observe(root, {
        attributes: true,
        attributeFilter: ['class']
      });

      this.mobileMenuSyncAdded = true;
      this.applyMobileMenuVisibility();
    },

    applyMobileMenuVisibility: function() {
      var bellWrapper = document.getElementById('bell-notifications-wrapper');
      if (!bellWrapper) {
        return;
      }

      var mobileMenuOpen = document.documentElement.classList.contains(
        'flyout-is-active'
      );
      var shouldHide = window.innerWidth <= 899 && mobileMenuOpen;

      if (shouldHide && this.dropdownOpen) {
        this.closeDropdown();
      }

      bellWrapper.classList.toggle(
        'bell-hidden-for-redmine-menu',
        shouldHide
      );
    },

    updateUnreadCount: function() {
      // 追加: 既にセッション切れを検知している場合は何もしない
      if (this.sessionExpired) return;
      
      var self = this;
      fetch(this.getUnreadCountUrl(), {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest'
        }
      })
      .then(function(response) {
        // 追加: 明示的な認証エラー(401)や権限エラー(403)を検知
        if (response.status === 401 || response.status === 403) {
          throw new Error('Session Expired');
        }
        if (!response.ok) {
          throw new Error('HTTP error ' + response.status);
        }
        return response.json();
      })
      
      .then(function(data) {
        self.renderBadge(data.count);
        // Reset failure count on success
        self.failureCount = 0;
        self.backoffMultiplier = 1;
        
        // 追加: 取得した最新の未読数を他のタブに共有する
        if (self.channel) {
          self.channel.postMessage({ count: data.count });
        }
      })
      .catch(function(error) {
        // 修正: エラーの種類に応じて処理を分岐
        if (error.message === 'Session Expired' || error.name === 'SyntaxError') {
          // SyntaxErrorは、Redmineがログイン画面(HTML)を返してきてJSONパースに失敗した場合
          console.warn('BellNotifications: Session expired. Stopping polling.');
          self.handleSessionExpired();
        } else {
          console.error('BellNotifications: Error fetching unread count:', error);
          self.handleFetchError();
        }
      });
    },
    
    // 追加: セッション切れ時の処理
    handleSessionExpired: function() {
      this.sessionExpired = true;
      this.stopPolling();
      
      // セッション切れのステータスでバッジを再描画
      this.renderBadge(null, 'expired');
    },
    
    handleFetchError: function() {
      this.failureCount++;

      if (this.failureCount >= this.maxFailures) {
        console.error('BellNotifications: Too many consecutive failures (' + this.failureCount + '), stopping polling');
        this.stopPolling();

        // Retry after a longer delay
        var self = this;
        setTimeout(function() {
          self.failureCount = 0;
          self.backoffMultiplier = 1;
          self.startPolling();
        }, CONSTANTS.POLLING_RETRY_DELAY_MS);
      } else {
        // Exponential backoff
        this.backoffMultiplier = Math.pow(2, this.failureCount - 1);
      }
    },

    // 変更: 引数に state を追加
    renderBadge: function(count, state) {
      var menu = document.getElementById('bell-notifications-menu');
      if (!menu) return;

      var badge = menu.querySelector('.unread-badge');

      // バッジ要素がなければ作成（初期生成時は「待ち受け中」）
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'unread-badge state-loading'; // 初期クラス
        badge.textContent = '...'; // 通信中を示すテキスト
        menu.appendChild(badge);
      }

      // 特殊な状態（セッション切れ）のハンドリング
      if (state === 'expired') {
        badge.className = 'unread-badge state-expired';
        badge.textContent = '!'; // セッション切れを示すアイコン代わり
        badge.title = 'Session Expired';
        return;
      }

      // 通常の件数更新のハンドリング
      if (typeof count !== 'undefined' && count !== null) {
        badge.textContent = count > CONSTANTS.MAX_BADGE_DISPLAY_COUNT
          ? CONSTANTS.MAX_BADGE_DISPLAY_COUNT + '+'
          : count.toString();
        
        // 件数に応じてクラスを切り替え
        if (count === 0) {
          badge.className = 'unread-badge state-none';
        } else {
          badge.className = 'unread-badge state-has-unread';
        }
      }

      badge.style.display = 'inline-block';
    },

    startPolling: function() {
      var self = this;

      // Clear any existing polling to prevent multiple intervals
      if (this.pollingIntervalId) {
        clearInterval(this.pollingIntervalId);
      }
      
      // 追加: 非表示タブではポーリングを開始しない
      if (document.hidden) return;
      
      this.pollingIntervalId = setInterval(function() {
        self.updateUnreadCount();
      }, this.pollInterval);
    },

    stopPolling: function() {
      if (this.pollingIntervalId) {
        clearInterval(this.pollingIntervalId);
        this.pollingIntervalId = null;
      }
    },

    setupTabSync: function() {
      // 古いブラウザ（IEなど）はサポートしていないためのフォールバック
      if (typeof BroadcastChannel !== 'undefined') {
        this.channel = new BroadcastChannel(CONSTANTS.CHANNEL_NAME);
        var self = this;
        
        // 他のタブからメッセージを受け取った時の処理
        this.channel.onmessage = function(event) {
          if (event.data && typeof event.data.count !== 'undefined') {
            self.renderBadge(event.data.count);
          }
        };
      }
    },

    setupVisibilityListener: function() {
      var self = this;
      document.addEventListener('visibilitychange', function() {
        if (document.hidden) {
          // タブが隠れたらポーリングを停止して負荷を減らす
          self.stopPolling();
        } else {
          // タブがアクティブになったら即座に最新を取得し、ポーリングを再開する
          self.updateUnreadCount();
          self.startPolling();
        }
      });
    },
    
    bindEvents: function() {
      var self = this;

      // Mark as read button (without navigation)
      document.addEventListener('click', function(e) {
        var markReadBtn = e.target.closest('.bell-notification-mark-read');
        if (markReadBtn) {
          e.preventDefault();
          e.stopPropagation(); // Prevent notification click event
          self.handleMarkAsReadClick(markReadBtn);
        }
      });

      // Click notification to mark as read and navigate
      document.addEventListener('click', function(e) {
        var notification = e.target.closest('.bell-notification');
        if (notification && !e.target.closest('.bell-notification-mark-read')) {
          e.preventDefault();
          self.handleNotificationClick(notification);
        }
      });

      // Mark all as read
      document.addEventListener('click', function(e) {
        if (e.target.id === 'bell-mark-all-read' || e.target.closest('#bell-mark-all-read')) {
          e.preventDefault();
          self.markAllAsRead();
        }
      });

      // Toggle read section
      document.addEventListener('click', function(e) {
        var readToggle = e.target.closest('#bell-read-toggle');
        if (readToggle) {
          e.preventDefault();
          self.toggleReadSection();
        }
      });

      // Toggle dropdown when clicking bell icon
      document.addEventListener('click', function(e) {
        var bellIcon = e.target.closest('#bell-notifications-menu');
        if (bellIcon) {
          e.preventDefault();
          self.toggleDropdown();
        }
      });

      // Close dropdown when clicking outside
      document.addEventListener('click', function(e) {
        if (self.dropdownOpen &&
            !e.target.closest('#bell-notifications-menu') &&
            !e.target.closest('.bell-notifications-dropdown')) {
          self.closeDropdown();
        }
      });
    },

    handleMarkAsReadClick: function(button) {
      var self = this;
      var notificationId = button.getAttribute('data-notification-id');
      var notification = button.closest('.bell-notification');

      if (!notificationId) {
        console.warn('BellNotifications: No notification ID found');
        return;
      }

      // Mark as read without navigation
      fetch(this.getMarkReadUrl(notificationId), {
        method: 'PUT',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'X-CSRF-Token': self.getCSRFToken()
        }
      })
      .then(function(response) {
        return response.json();
      })
      .then(function(data) {
        if (data.success && notification) {
          // Move notification to read section instead of removing
          self.moveNotificationToReadSection(notification);
          // Update the unread count
          self.updateUnreadCount();
        }
      })
      .catch(function(error) {
        console.error('BellNotifications: Error marking as read:', error);
      });
    },

    handleNotificationClick: function(notification) {
      var self = this;
      var notificationId = notification.getAttribute('data-notification-id');
      var url = notification.getAttribute('data-url');

      if (!notificationId || !self.isSafeInternalPath(url)) return;

      fetch(this.getMarkReadUrl(notificationId), {
        method: 'PUT',
        headers: {
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'X-CSRF-Token': self.getCSRFToken()
        },
        keepalive: true
      });

      window.location.href = url;
    },

    markAllAsRead: function() {
      var self = this;
      var button = document.getElementById('bell-mark-all-read');

      if (!button) return;

      // Store original text
      var originalText = button.textContent;

      // Show loading state
      button.textContent = 'Marking...';
      button.style.opacity = '0.6';
      button.style.pointerEvents = 'none';

      fetch(this.getMarkAllReadUrl(), {
        method: 'PUT',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'X-CSRF-Token': self.getCSRFToken()
        }
      })
      .then(function(response) {
        return response.json();
      })
      .then(function(data) {
        if (data.success) {
          // Show success feedback
          button.textContent = 'Done!';
          button.style.backgroundColor = '#28a745';
          button.style.color = '#fff';
          button.style.opacity = '1';

          // Move all unread notifications to read section
          var unreadSection = document.getElementById('bell-unread-section');
          if (unreadSection) {
            var unreadNotifications = unreadSection.querySelectorAll('.bell-notification');
            unreadNotifications.forEach(function(notif) {
              self.moveNotificationToReadSection(notif);
            });
          }

          self.updateUnreadCount();

          // Reset button after feedback duration
          setTimeout(function() {
            button.textContent = originalText;
            button.style.backgroundColor = '';
            button.style.color = '';
            button.style.pointerEvents = '';
          }, CONSTANTS.MARK_ALL_FEEDBACK_DURATION_MS);
        }
      })
      .catch(function(error) {
        console.error('BellNotifications: Error marking all as read:', error);
        // Reset button on error
        button.textContent = originalText;
        button.style.opacity = '1';
        button.style.pointerEvents = '';
      });
    },

    moveNotificationToReadSection: function(notification) {
      if (!notification) return;

      // Remove unread styling
      notification.classList.remove('unread');

      // Get or create read section
      var readSection = document.getElementById('bell-read-section');
      var unreadSection = document.getElementById('bell-unread-section');

      if (!readSection) {
        // Create read section if it doesn't exist
        var dropdownList = document.querySelector('.bell-notifications-list');
        if (dropdownList) {
          var readSectionHTML = '<div class="bell-section-header bell-section-collapsible bell-section-collapsed-state" id="bell-read-toggle">' +
            '<h5><span class="bell-collapse-icon"></span> Read (1)</h5>' +
            '</div>' +
            '<div class="bell-section-content bell-section-collapsed" id="bell-read-section"></div>';
          dropdownList.insertAdjacentHTML('beforeend', readSectionHTML);
          readSection = document.getElementById('bell-read-section');
        }
      }

      if (readSection) {
        // Add fade effect
        notification.style.opacity = '0.5';
        setTimeout(function() {
          // Move to read section
          readSection.insertBefore(notification, readSection.firstChild);
          notification.style.opacity = '1';

          // Update counts
          var unreadCount = unreadSection ? unreadSection.querySelectorAll('.bell-notification').length : 0;
          var readCount = readSection.querySelectorAll('.bell-notification').length;

          // Update unread count display
          var unreadCountSpan = document.getElementById('bell-unread-count');
          if (unreadCountSpan) {
            unreadCountSpan.textContent = unreadCount;
          }

          // Update read section header count
          var readToggle = document.getElementById('bell-read-toggle');
          if (readToggle) {
            var readTitle = readToggle.querySelector('h5');
            if (readTitle) {
              readTitle.innerHTML = '<span class="bell-collapse-icon"></span> Read (' + readCount + ')';
            }
          }

          // Hide unread section if empty
          if (unreadCount === 0 && unreadSection) {
            var unreadHeader = unreadSection.previousElementSibling;
            if (unreadHeader && unreadHeader.classList.contains('bell-section-header')) {
              unreadHeader.style.display = 'none';
            }
            unreadSection.style.display = 'none';

            // Hide mark all as read button
            var markAllBtn = document.getElementById('bell-mark-all-read');
            if (markAllBtn) {
              markAllBtn.style.display = 'none';
            }
          }
        }, 300);
      }
    },

    toggleReadSection: function() {
      var readSection = document.getElementById('bell-read-section');
      var readToggle = document.getElementById('bell-read-toggle');

      if (readSection && readToggle) {
        var isCollapsed = readSection.classList.contains('bell-section-collapsed');

        // Toggle collapsed state
        readSection.classList.toggle('bell-section-collapsed');

        // Toggle class on header to control arrow direction
        if (isCollapsed) {
          readToggle.classList.remove('bell-section-collapsed-state');
        } else {
          readToggle.classList.add('bell-section-collapsed-state');
        }
      }
    },

    toggleDropdown: function() {
      if (this.dropdownOpen) {
        this.closeDropdown();
      } else {
        this.openDropdown();
      }
    },

    openDropdown: function() {
      var self = this;

      fetch(this.getDropdownUrl(), {
        method: 'GET',
        headers: {
          'X-Requested-With': 'XMLHttpRequest'
        }
      })
      .then(function(response) {
        return response.text();
      })
      .then(function(html) {
        // Remove any existing dropdown
        var existing = document.querySelector('.bell-notifications-dropdown');
        if (existing) {
          existing.remove();
        }

        // Insert dropdown HTML relative to the bell menu item
        var menu = document.getElementById('bell-notifications-menu');
        if (menu) {
          // Create a container that will be positioned relative to the icon
          var container = document.createElement('div');
          container.style.position = 'relative';
          container.style.display = 'inline-block';
          container.innerHTML = html;

          // Insert after the bell icon
          menu.parentNode.insertBefore(container, menu.nextSibling);
          self.dropdownOpen = true;
        } else {
          console.error('BellNotifications: Could not find bell menu element');
        }
      })
      .catch(function(error) {
        console.error('BellNotifications: Error loading dropdown:', error);
      });
    },

    closeDropdown: function() {
      var dropdown = document.querySelector('.bell-notifications-dropdown');
      if (dropdown) {
        // Remove the parent container that was created
        var parent = dropdown.parentNode;
        if (parent && parent.parentNode) {
          parent.remove();
        } else {
          dropdown.remove();
        }
      }
      this.dropdownOpen = false;
    },

    getCSRFToken: function() {
      var meta = document.querySelector('meta[name="csrf-token"]');
      return meta ? meta.getAttribute('content') : '';
    }
  };

  // Initialize when script loads
  BellNotifications.init();

  // Expose to global scope if needed
  window.BellNotifications = BellNotifications;
})();
