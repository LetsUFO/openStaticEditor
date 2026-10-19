<script setup lang="ts">
interface Props {
	msg?: string;
}

const props = withDefaults(defineProps<Props>(), {
	msg: 'Hello Vue 3 + Pinia + Electron'
});
</script>

<template>
	<h2 class="hello">{{ props.msg }}</h2>
</template>

<style scoped>
.hello {
	font-weight: 600;
	color: #2c3e50;
	margin: 12px 0;
}
</style>
