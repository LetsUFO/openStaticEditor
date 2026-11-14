<script setup lang="ts">
import { computed, ref } from 'vue';
import { Button, Modal } from 'ant-design-vue';
import { CoffeeOutlined } from '@ant-design/icons-vue';

const props = defineProps<{
	/** config.json -> sponsor：赞助入口配置 */
	sponsor: AppSponsor;
}>();

const visible = ref(false);
const text = computed(() => props.sponsor.text || '赞助支持');

// 相对路径走 app-asset 协议（主进程按 custom -> 项目根/resources 顺序解析）；
// http(s) / data: / blob: 直接使用
const assetUrl = (src: string): string => {
	if (!src) return '';
	if (/^(?:data:|blob:|http:|https:)/i.test(src)) return src;
	return `app-asset://local/?src=${encodeURIComponent(src)}`;
};

// 域名白名单在主进程校验，非白名单链接会被拒绝
const openLink = async () => {
	if (!props.sponsor.link) return;
	await window.api.openExternal(props.sponsor.link);
};

// 配了二维码就弹层放大（方便手机扫），没配就直接跳浏览器
const onClick = () => {
	if (props.sponsor.src) {
		visible.value = true;
	} else {
		openLink();
	}
};
</script>

<template>
	<div class="sponsor select-none">
		<div class="entry flex items-center justify-center gap-1 cursor-pointer" @click="onClick">
			<CoffeeOutlined />
			<span>{{ text }}</span>
		</div>
		<Modal v-model:open="visible" :title="text" :footer="null" centered>
			<div class="text-center">
				<img
					v-if="sponsor.src"
					class="qr block mx-auto object-contain rounded"
					:src="assetUrl(sponsor.src)"
					:alt="text"
				/>
				<Button class="mt-4" type="primary" @click="openLink">在浏览器打开</Button>
			</div>
		</Modal>
	</div>
</template>

<style lang="scss" scoped>
.entry {
	margin: 0 0.5rem 0.5rem;
	padding: 0.375rem 0;
	border-radius: 0.375rem;
	font-size: 0.75rem;
	color: var(--dark-fcLv1);
	background-color: rgba(255, 255, 255, 0.06);
	transition:
		background-color 0.2s ease-in-out,
		color 0.2s ease-in-out;
	&:hover {
		color: #fff;
		background-color: rgba(255, 255, 255, 0.14);
	}
}
.qr {
	width: 14rem;
	height: 14rem;
}
</style>
