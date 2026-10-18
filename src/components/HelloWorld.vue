<script setup>
defineProps({
  msg: {
    type: String,
    default: 'Hello Vue 3 + Pinia + Electron'
  }
})
</script>

<template>
  <h2 class="hello">{{ msg }}</h2>
</template>

<style scoped>
.hello {
  font-weight: 600;
  color: #2c3e50;
  margin: 12px 0;
}
</style>
