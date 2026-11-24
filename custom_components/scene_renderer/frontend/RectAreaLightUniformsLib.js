// Vendored from three@0.187.0 (scene-renderer/node_modules/three) so the panel
// runs with NO build step: the files are served as-is from this directory.
// Patched for vendoring: the bare `from 'three'` import is rewritten to a
// relative import of the vendored ./three.module.js. Nothing else changed —
// to update three.js, re-copy the files and re-apply this patch.
import { UniformsLib } from './three.module.js';
import { RectAreaLightTexturesLib } from './RectAreaLightTexturesLib.js';

/**
 * This class is only relevant when using {@link RectAreaLight} with {@link WebGLRenderer}.
 *
 * Before rect area lights can be used, the internal uniform library of the renderer must be
 * enhanced with the following code.
 *
 * ```js
 * RectAreaLightUniformsLib.init();
 * ```
 *
 * @hideconstructor
 * @three_import import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
 */
class RectAreaLightUniformsLib {

	/**
	 * Inits the uniform library required when using rect area lights.
	 */
	static init() {

		RectAreaLightTexturesLib.init();

		const { LTC_FLOAT_1, LTC_FLOAT_2, LTC_HALF_1, LTC_HALF_2 } = RectAreaLightTexturesLib;

		// data textures

		UniformsLib.LTC_FLOAT_1 = LTC_FLOAT_1;
		UniformsLib.LTC_FLOAT_2 = LTC_FLOAT_2;

		UniformsLib.LTC_HALF_1 = LTC_HALF_1;
		UniformsLib.LTC_HALF_2 = LTC_HALF_2;

	}

}

export { RectAreaLightUniformsLib };
