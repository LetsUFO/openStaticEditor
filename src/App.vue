<script setup lang="ts">
import { useCounterStore } from './stores/counter';
import { useConfigStore } from './stores/config';

import HelloWorld from './components/HelloWorld.vue';
import LoadFile from './components/LoadFile.vue';

const counter = useCounterStore();
// custom/config.json 的数据（主进程读取 → IPC → 本 store）
const configStore = useConfigStore();
</script>

<template>
	<div class="">
		<div class="flex justify-start">
			<div class="w-[10rem]">asdasd</div>
			<div class="flex-1">
				<HelloWorld />
				<h1 class="text-primary">{{ configStore.config?.name ?? 'OpenStaticEditor' }}</h1>
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
