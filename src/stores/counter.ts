import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

// Pinia 组合式写法（setup store）—— TS 下类型自动推断
export const useCounterStore = defineStore('counter', () => {
	const count = ref(0);
	const double = computed(() => count.value * 2);

	function increment(): void {
		count.value++;
	}

	function decrement(): void {
		count.value--;
	}

	return { count, double, increment, decrement };
});
