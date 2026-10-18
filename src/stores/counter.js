import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

// Pinia 组合式写法（setup store）
export const useCounterStore = defineStore('counter', () => {
  const count = ref(0)
  const double = computed(() => count.value * 2)

  function increment() {
    count.value++
  }

  function decrement() {
    count.value--
  }

  return { count, double, increment, decrement }
})
