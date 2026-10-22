Component({
  properties: {
    text: { type: String, value: '' },
    // 词条唯一标识，回传给页面用于配对判断
    wkey: { type: String, value: '' },
    // idle | selected | matched | wrong
    state: { type: String, value: 'idle' },
    // en 英文卡 / cn 中文卡
    variant: { type: String, value: 'en' },
    disabled: { type: Boolean, value: false }
  },

  data: {
    sizeClass: 'md'
  },

  observers: {
    'text, variant': function (t, variant) {
      const len = (t || '').length;
      let sizeClass = 'md';
      if (variant === 'cn') {
        sizeClass = len <= 8 ? 'lg' : len <= 16 ? 'md' : len <= 30 ? 'sm' : 'xs';
      } else {
        sizeClass = len <= 7 ? 'lg' : len <= 12 ? 'md' : 'sm';
      }
      if (sizeClass !== this.data.sizeClass) {
        this.setData({ sizeClass: sizeClass });
      }
    }
  },

  methods: {
    onTap() {
      if (this.data.disabled) return;
      this.triggerEvent('select', {
        side: this.data.variant,
        key: this.data.wkey
      });
    }
  }
});
