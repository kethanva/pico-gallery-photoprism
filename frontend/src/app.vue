<template>
  <div id="photoprism" :class="['theme-' + themeName]">
    <p-loading-bar height="4"></p-loading-bar>

    <v-app :class="appClass">
      <!-- Kiosk (?kiosk / ?slideshow): the frame is a locked photo surface, so
           the PhotoPrism navigation rail is not rendered — v-if (not CSS) so
           Vuetify's layout reclaims the space and v-main spans full width. -->
      <p-navigation v-if="!kioskMode"></p-navigation>

      <v-main>
        <router-view></router-view>
      </v-main>
    </v-app>

    <p-dialogs></p-dialogs>
    <p-notify></p-notify>
  </div>
</template>

<script>
import PLoadingBar from "component/loading-bar.vue";
import PNotify from "component/notify.vue";
import PNavigation from "component/navigation.vue";
import PDialogs from "component/dialogs.vue";

export default {
  name: "App",
  components: {
    PLoadingBar,
    PNotify,
    PNavigation,
    PDialogs,
  },
  data() {
    return {
      themeName: this.$config.themeName,
      subscriptions: [],
      touchStart: 0,
    };
  },
  computed: {
    // Kiosk mode: the appliance boots to /library/photos?kiosk=true and every
    // in-frame navigation carries the kiosk flag, so the frame stays a locked,
    // photos-only surface with no PhotoPrism chrome.
    kioskMode: function () {
      return !!(this.$route.query.kiosk || this.$route.query.slideshow);
    },
    appClass: function () {
      return [
        this.$route.meta.background,
        this.$vuetify.display.smAndDown ? "small-screen" : "large-screen",
        this.$route.meta.hideNav || this.kioskMode ? "hide-nav" : "show-nav",
        this.kioskMode ? "kiosk-mode" : null,
      ];
    },
  },
  created() {
    this.subscriptions.push(this.$event.subscribe("view.refresh", (ev, data) => this.onRefresh(data)));
    this.$config.setVuetify(this.$vuetify);
  },
  mounted() {
    this.$view.enter(this);
  },
  beforeUnmount() {
    for (let i = 0; i < this.subscriptions.length; i++) {
      this.$event.unsubscribe(this.subscriptions[i]);
    }
  },
  unmounted() {
    this.$view.leave(this);
  },
  methods: {
    onRefresh(config) {
      this.themeName = config.themeName;
    },
  },
};
</script>
