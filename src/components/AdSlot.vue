<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
	/** config.json -> ads：图片推广位列表，按顺序纵向排列 */
	items: AppAd[];
}>();

// 相对路径走 app-asset 协议（主进程按 custom -> 项目根/resources 顺序解析）；
// http(s) / data: / blob: 直接使用
const assetUrl = (src: string): string => {
	if (!src) return '';
	if (/^(?:data:|blob:|http:|https:)/i.test(src)) return src;
	return `app-asset://local/?src=${encodeURIComponent(src)}`;
};

// 没有图片的条目直接忽略，避免渲染出坏图占位
const list = computed(() => props.items.filter((ad) => ad?.src));

const open = async (ad: AppAd) => {
	if (!ad?.link) return;
	// 域名白名单在主进程校验，非淘宝/天猫链接会被拒绝
	await window.api.openExternal(ad.link);
};
</script>

<template>
	<div v-if="list.length" class="ad-slot select-none">
		<a
			v-for="(ad, i) in list"
			:key="i"
			class="ad block cursor-pointer"
			:class="{ 'mt-2': i > 0 }"
			:title="ad.alt || ''"
			@click="open(ad)"
		>
			<img class="w-full block" :src="assetUrl(ad.src)" :alt="ad.alt || ''" />
		</a>
	</div>
</template>

<style lang="scss" scoped>
.ad {
	opacity: 0.85;
	transition: opacity 0.2s ease-in-out;
	&:hover {
		opacity: 1;
	}
	img {
		display: block;
		width: 100%;
		height: auto;
		// 侧栏高度有限，过高的竖版素材做限制，避免把菜单挤没
		max-height: 20rem;
		object-fit: contain;
	}
}
</style>
