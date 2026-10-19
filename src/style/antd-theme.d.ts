// 让 TS / vue-tsc 识别 antd seed token 的深路径 import（antd 未为此导出类型）
declare module 'ant-design-vue/es/theme/themes/seed.js' {
	interface AntdSeedToken {
		colorPrimary: string
		colorSuccess: string
		colorWarning: string
		colorError: string
		colorInfo: string
	}
	const seedToken: AntdSeedToken
	export default seedToken
}
