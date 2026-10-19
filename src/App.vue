<script setup lang="ts">
import { useCounterStore } from './stores/counter';
import HelloWorld from './components/HelloWorld.vue';

const counter = useCounterStore();
</script>

<template>
	<div class="stage margin-auto-x">
		<h1 class="text-primary">OpenStaticEditor</h1>
		<p class="sub">Vue 3 + Pinia + Electron 桌面应用骨架</p>

		<HelloWorld />

		<div class="counter">
			<button @click="counter.decrement">-</button>
			<span class="value">
				count: <b>{{ counter.count }}</b> / double: <b>{{ counter.double }}</b>
			</span>
			<button @click="counter.increment">+</button>
		</div>
	</div>
</template>

<style>
:root {
	font-family:
		system-ui,
		-apple-system,
		'Segoe UI',
		Roboto,
		sans-serif;
	color: #2c3e50;
}

body {
	margin: 0;
	background: #f7f8fa;
}

.stage {
	width: 720px;
	padding: 48px 24px;
	text-align: center;
}

.sub {
	color: #8a94a6;
	margin-bottom: 32px;
}

.counter {
	display: inline-flex;
	align-items: center;
	gap: 16px;
	margin-top: 16px;
	padding: 16px 24px;
	background: #fff;
	border-radius: 12px;
	box-shadow: 0 2px 12px rgba(0, 0, 0, 0.06);
}

.counter button {
	width: 40px;
	height: 40px;
	font-size: 20px;
	border: none;
	border-radius: 8px;
	background: #3b82f6;
	color: #fff;
	cursor: pointer;
}

.counter button:active {
	transform: scale(0.96);
}

.counter .value {
	min-width: 220px;
	font-size: 15px;
}
</style>
