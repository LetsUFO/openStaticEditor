<script setup lang="ts">
import { Button } from 'ant-design-vue';
import { reactive } from 'vue';
import { useConfigStore } from '@renderer/stores/config';

interface Props {
	// state: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	// state: false
});

const needFiles = useConfigStore().config?.loadFiles || [];
const state = reactive({ loaded: false });
</script>

<template>
	<div class="root fixed w-full h-full backdrop-blur-md z-1 grid place-content-center">
		<ul>
			<li v-for="(file, key) in needFiles" :key="key">{{ file.fileSrc }}</li>
		</ul>
		<Button :type="'primary'" :size="'large'">加载文件</Button>
	</div>
</template>

<style scoped>
.root {
	background-color: rgba(0, 0, 0, 0.8);
}
</style>
