<script setup lang="ts">
import { useCounterStore } from './stores/counter';
import { useConfigStore } from './stores/config';
import { dark } from './style/theme';

import { Menu } from 'ant-design-vue';
import HelloWorld from './components/HelloWorld.vue';
import LoadFile from './components/LoadFile.vue';
import { computed } from 'vue';

const counter = useCounterStore();
// custom/config.json 的数据（主进程读取 → IPC → 本 store）
const configStore = computed(() => {
	return useConfigStore().config;
});
</script>

<template>
	<div class="">
		<div class="flex justify-start">
			<ul class="menu w-[10rem] bg-primary bgDarken">
				<Menu :theme="'dark'" :items="configStore?.menu"></Menu>
			</ul>
			<div class="flex-1">
				<HelloWorld />
				<h1 class="text-primary">{{ configStore?.name ?? 'OpenStaticEditor' }}</h1>
				<p class="sub">Vue 3 + Pinia + Electron 桌面应用骨架</p>
				<button @click="counter.decrement">-</button>
				<span class="value">
					count: <b>{{ counter.count }}</b> / double: <b>{{ counter.double }}</b>
				</span>
				<button @click="counter.increment">+</button>
			</div>
		</div>
	</div>
</template>

<style lang="scss" scoped></style>
